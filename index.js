require("dotenv").config();

const fs = require("fs");
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const admin = require("firebase-admin");

const app = express();

/* ---------------- CONFIGURATION ---------------- */

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY is missing");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY.trim());

const MAX_BOTS_BY_PLAN = {
  starter: 3,
  pro: 10,
  business: 9999,
};

function getMaxBots(plan) {
  return MAX_BOTS_BY_PLAN[plan] || 0;
}

/* ---------------- FIREBASE ADMIN ---------------- */

const serviceAccountPath =
  "/etc/secrets/firebase-service-account.json";

if (!fs.existsSync(serviceAccountPath)) {
  throw new Error(
    `Firebase service account file is missing at ${serviceAccountPath}`
  );
}

const serviceAccount = JSON.parse(
  fs.readFileSync(serviceAccountPath, "utf8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

/* ---------------- STRIPE WEBHOOK ---------------- */

/*
  Cette route doit obligatoirement rester avant express.json().
  Stripe a besoin du corps brut pour vérifier la signature.
*/
app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];
    let event;

    try {
      if (!process.env.STRIPE_WEBHOOK_SECRET) {
        throw new Error("STRIPE_WEBHOOK_SECRET is missing");
      }

      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET.trim()
      );
    } catch (err) {
      console.error("WEBHOOK SIGNATURE ERROR:", err.message);

      return res
        .status(400)
        .send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        /* Paiement initial réussi */
        case "checkout.session.completed": {
          const session = event.data.object;

          const userId = session.metadata?.userId;
          const plan = session.metadata?.plan;

          if (!userId || !plan) {
            throw new Error(
              "Missing userId or plan in session metadata"
            );
          }

          const normalizedPlan = String(plan)
            .trim()
            .toLowerCase();

          await db.collection("users").doc(userId).set(
            {
              isSeller: true,
              sellerPlan: normalizedPlan,
              subscriptionStatus: "active",
              subscriptionId: session.subscription || "",
              stripeCustomerId: session.customer || "",
              maxBots: getMaxBots(normalizedPlan),
            },
            { merge: true }
          );

          console.log(
            `Seller subscription activated: ${userId} / ${normalizedPlan} / maxBots=${getMaxBots(
              normalizedPlan
            )}`
          );

          break;
        }

        /* Abonnement renouvelé, modifié ou changement de statut */
        case "customer.subscription.updated": {
          const subscription = event.data.object;

          const userId = subscription.metadata?.userId;
          const rawPlan = subscription.metadata?.plan;

          if (!userId) {
            console.warn(
              "Subscription updated without userId metadata"
            );
            break;
          }

          const plan = rawPlan
            ? String(rawPlan).trim().toLowerCase()
            : "unknown";

          const activeStatuses = ["active", "trialing"];
          const isActive = activeStatuses.includes(
            subscription.status
          );

          await db.collection("users").doc(userId).set(
            {
              isSeller: isActive,
              sellerPlan: isActive ? plan : "none",
              subscriptionStatus: isActive
                ? "active"
                : subscription.status,
              subscriptionId: subscription.id,
              stripeCustomerId:
                typeof subscription.customer === "string"
                  ? subscription.customer
                  : "",
              maxBots: isActive ? getMaxBots(plan) : 0,
            },
            { merge: true }
          );

          console.log(
            `Seller subscription updated: ${userId} / ${subscription.status}`
          );

          break;
        }

        /* Abonnement définitivement supprimé ou résilié */
        case "customer.subscription.deleted": {
          const subscription = event.data.object;
          const userId = subscription.metadata?.userId;

          if (!userId) {
            console.warn(
              "Subscription deleted without userId metadata"
            );
            break;
          }

          await db.collection("users").doc(userId).set(
            {
              isSeller: false,
              sellerPlan: "none",
              subscriptionStatus: "cancelled",
              subscriptionId: subscription.id,
              maxBots: 0,
            },
            { merge: true }
          );

          console.log(
            `Seller subscription cancelled: ${userId}`
          );

          break;
        }

        /* Paiement mensuel échoué */
        case "invoice.payment_failed": {
          const invoice = event.data.object;
          const subscriptionId = invoice.subscription;

          if (!subscriptionId) {
            console.warn(
              "Payment failed without subscriptionId"
            );
            break;
          }

          const subscription =
            await stripe.subscriptions.retrieve(
              subscriptionId
            );

          const userId = subscription.metadata?.userId;

          if (!userId) {
            console.warn(
              "Payment failed without userId metadata"
            );
            break;
          }

          await db.collection("users").doc(userId).set(
            {
              isSeller: false,
              subscriptionStatus: "payment_failed",
              maxBots: 0,
            },
            { merge: true }
          );

          console.log(
            `Seller payment failed: ${userId}`
          );

          break;
        }

        default:
          console.log(
            `Unhandled Stripe event: ${event.type}`
          );
      }

      return res.json({ received: true });
    } catch (err) {
      console.error("WEBHOOK PROCESSING ERROR:", err);

      return res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }
);

/* Toutes les autres routes utilisent du JSON normal. */

app.use(cors());
app.use(express.json());

/* ---------------- SERVER CHECK ---------------- */

app.get("/", (req, res) => {
  res.json({
    status: "Atlas Bot Stripe server running",
    hasStripeKey: Boolean(process.env.STRIPE_SECRET_KEY),
    hasWebhookSecret: Boolean(
      process.env.STRIPE_WEBHOOK_SECRET
    ),
    firebaseConnected: Boolean(admin.apps.length),
    plans: MAX_BOTS_BY_PLAN,
  });
});

/* ---------------- STRIPE TEST ---------------- */

app.get("/debug-stripe", async (req, res) => {
  try {
    const balance = await stripe.balance.retrieve();

    res.json({
      success: true,
      message: "Stripe connection OK",
      balance,
    });
  } catch (err) {
    console.error("DEBUG STRIPE ERROR:", err);

    res.status(500).json({
      success: false,
      message: err.message,
      type: err.type,
      code: err.code,
    });
  }
});

/* ---------------- STRIPE CONNECT ---------------- */

app.post("/create-connect-account", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: "Email is required",
      });
    }

    const account = await stripe.accounts.create({
      type: "express",
      country: "FR",
      email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    });

    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url:
        "https://atlas-stripe.onrender.com",
      return_url:
        "https://atlas-stripe.onrender.com",
      type: "account_onboarding",
    });

    res.json({
      success: true,
      accountId: account.id,
      onboardingUrl: accountLink.url,
    });
  } catch (err) {
    console.error("CREATE CONNECT ERROR:", err);

    res.status(500).json({
      success: false,
      message: err.message,
      type: err.type,
      code: err.code,
    });
  }
});

/* ---------------- SELLER SUBSCRIPTIONS ---------------- */

app.post(
  "/create-seller-subscription",
  async (req, res) => {
    try {
      const { email, userId, plan } = req.body;

      if (!email || !userId || !plan) {
        return res.status(400).json({
          success: false,
          error:
            "email, userId and plan are required",
        });
      }

      const normalizedPlan = String(plan)
        .trim()
        .toLowerCase();

      const priceIds = {
        starter: process.env.STRIPE_PRICE_STARTER,
        pro: process.env.STRIPE_PRICE_PRO,
        business:
          process.env.STRIPE_PRICE_BUSINESS,
      };

      const priceId = priceIds[normalizedPlan];

      if (!priceId) {
        return res.status(400).json({
          success: false,
          error: "Invalid plan",
        });
      }

      const session =
        await stripe.checkout.sessions.create({
          mode: "subscription",
          customer_email: email,
          line_items: [
            {
              price: priceId,
              quantity: 1,
            },
          ],
          success_url:
            "https://atlas-stripe.onrender.com/subscription-success?session_id={CHECKOUT_SESSION_ID}",
          cancel_url:
            "https://atlas-stripe.onrender.com/subscription-cancelled",
          metadata: {
            userId,
            plan: normalizedPlan,
          },
          subscription_data: {
            metadata: {
              userId,
              plan: normalizedPlan,
            },
          },
        });

      res.json({
        success: true,
        checkoutUrl: session.url,
        sessionId: session.id,
        plan: normalizedPlan,
        maxBots: getMaxBots(normalizedPlan),
      });
    } catch (err) {
      console.error(
        "CREATE SUBSCRIPTION ERROR:",
        err
      );

      res.status(500).json({
        success: false,
        message: err.message,
        type: err.type,
        code: err.code,
      });
    }
  }
);

/* ---------------- RETURN PAGES ---------------- */

app.get("/subscription-success", (req, res) => {
  res.send(`
    <h1>Abonnement activé</h1>
    <p>Le paiement a été validé.</p>
    <p>Vous pouvez retourner dans Atlas Bot.</p>
  `);
});

app.get("/subscription-cancelled", (req, res) => {
  res.send(`
    <h1>Paiement annulé</h1>
    <p>Aucun abonnement n’a été créé.</p>
    <p>Vous pouvez retourner dans Atlas Bot.</p>
  `);
});

/* ---------------- START SERVER ---------------- */

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(
    `Atlas Bot Stripe server running on port ${PORT}`
  );
});
