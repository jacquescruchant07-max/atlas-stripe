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

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

/* ---------------- AUTHENTIFICATION FIREBASE ---------------- */

async function requireFirebaseAuth(req, res, next) {
  try {
    const authorization = req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Firebase authentication token is required",
      });
    }

    const idToken = authorization.slice(7).trim();

    if (!idToken) {
      return res.status(401).json({
        success: false,
        error: "Firebase authentication token is missing",
      });
    }

    const decodedToken = await admin
      .auth()
      .verifyIdToken(idToken);

    req.user = decodedToken;
    next();
  } catch (err) {
    console.error("AUTHENTICATION ERROR:", err.message);

    return res.status(401).json({
      success: false,
      error: "Invalid or expired authentication token",
    });
  }
}

/* ---------------- STRIPE WEBHOOK ---------------- */

/*
  Cette route doit rester avant express.json().
  Stripe exige le corps brut pour vérifier la signature.
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
      console.error(
        "WEBHOOK SIGNATURE ERROR:",
        err.message
      );

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
          const rawPlan = session.metadata?.plan;

          if (!userId || !rawPlan) {
            throw new Error(
              "Missing userId or plan in session metadata"
            );
          }

          const plan = String(rawPlan)
            .trim()
            .toLowerCase();

          await db.collection("users").doc(userId).set(
            {
              isSeller: true,
              sellerPlan: plan,
              subscriptionStatus: "active",
              subscriptionId:
                typeof session.subscription === "string"
                  ? session.subscription
                  : "",
              stripeCustomerId:
                typeof session.customer === "string"
                  ? session.customer
                  : "",
              maxBots: getMaxBots(plan),
              cancelAtPeriodEnd: false,
            },
            { merge: true }
          );

          console.log(
            `Seller subscription activated: ${userId} / ${plan}`
          );

          break;
        }

        /* Modification, renouvellement ou résiliation programmée */
        case "customer.subscription.updated": {
          const subscription = event.data.object;

          const userId =
            subscription.metadata?.userId;
          const rawPlan =
            subscription.metadata?.plan;

          if (!userId) {
            console.warn(
              "Subscription updated without userId metadata"
            );
            break;
          }

          const plan = rawPlan
            ? String(rawPlan).trim().toLowerCase()
            : "unknown";

          const activeStatuses = [
            "active",
            "trialing",
          ];

          const isActive = activeStatuses.includes(
            subscription.status
          );

          const cancellationPending =
            Boolean(subscription.cancel_at_period_end) ||
            Boolean(subscription.cancel_at);

          await db.collection("users").doc(userId).set(
            {
              isSeller: isActive,
              sellerPlan: isActive ? plan : "none",
              subscriptionStatus: isActive
                ? cancellationPending
                  ? "cancelling"
                  : "active"
                : subscription.status,
              subscriptionId: subscription.id,
              stripeCustomerId:
                typeof subscription.customer === "string"
                  ? subscription.customer
                  : "",
              maxBots: isActive
                ? getMaxBots(plan)
                : 0,
              cancelAtPeriodEnd:
                cancellationPending,
              subscriptionEndsAt:
                subscription.cancel_at
                  ? admin.firestore.Timestamp.fromMillis(
                      subscription.cancel_at * 1000
                    )
                  : null,
            },
            { merge: true }
          );

          console.log(
            `Seller subscription updated: ${userId} / ${subscription.status}`
          );

          break;
        }

        /* Abonnement réellement terminé */
        case "customer.subscription.deleted": {
          const subscription = event.data.object;
          const userId =
            subscription.metadata?.userId;

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
              subscriptionId: "",
              maxBots: 0,
              cancelAtPeriodEnd: false,
              subscriptionEndsAt: null,
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

          const subscriptionId =
            typeof invoice.subscription === "string"
              ? invoice.subscription
              : null;

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

          const userId =
            subscription.metadata?.userId;

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
      console.error(
        "WEBHOOK PROCESSING ERROR:",
        err
      );

      return res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }
);

/* Toutes les routes suivantes utilisent du JSON normal. */

app.use(cors());
app.use(express.json());

/* ---------------- SERVER CHECK ---------------- */

app.get("/", (req, res) => {
  res.json({
    status: "Atlas Bot Stripe server running",
    hasStripeKey: Boolean(
      process.env.STRIPE_SECRET_KEY
    ),
    hasWebhookSecret: Boolean(
      process.env.STRIPE_WEBHOOK_SECRET
    ),
    firebaseConnected: Boolean(
      admin.apps.length
    ),
    plans: MAX_BOTS_BY_PLAN,
  });
});

/* ---------------- STRIPE TEST ---------------- */

app.get("/debug-stripe", async (req, res) => {
  try {
    const balance =
      await stripe.balance.retrieve();

    res.json({
      success: true,
      message: "Stripe connection OK",
      balance,
    });
  } catch (err) {
    console.error(
      "DEBUG STRIPE ERROR:",
      err
    );

    res.status(500).json({
      success: false,
      message: err.message,
      type: err.type,
      code: err.code,
    });
  }
});

/* ---------------- STRIPE CONNECT ---------------- */

app.post(
  "/create-connect-account",
  async (req, res) => {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({
          success: false,
          error: "Email is required",
        });
      }

      const account =
        await stripe.accounts.create({
          type: "express",
          country: "FR",
          email,
          capabilities: {
            card_payments: {
              requested: true,
            },
            transfers: {
              requested: true,
            },
          },
        });

      const accountLink =
        await stripe.accountLinks.create({
          account: account.id,
          refresh_url:
            "https://atlas-stripe.onrender.com",
          return_url:
            "https://atlas-stripe.onrender.com",
          type: "account_onboarding",
        });

      return res.json({
        success: true,
        accountId: account.id,
        onboardingUrl: accountLink.url,
      });
    } catch (err) {
      console.error(
        "CREATE CONNECT ERROR:",
        err
      );

      return res.status(500).json({
        success: false,
        message: err.message,
        type: err.type,
        code: err.code,
      });
    }
  }
);

/* ---------------- CRÉATION ABONNEMENT VENDEUR ---------------- */

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
        starter:
          process.env.STRIPE_PRICE_STARTER,
        pro:
          process.env.STRIPE_PRICE_PRO,
        business:
          process.env.STRIPE_PRICE_BUSINESS,
      };

      const priceId =
        priceIds[normalizedPlan];

      if (!priceId) {
        return res.status(400).json({
          success: false,
          error: "Invalid plan",
        });
      }

      const userRef = db
        .collection("users")
        .doc(userId);

      const userSnapshot =
        await userRef.get();

      const existingCustomerId =
        userSnapshot.exists
          ? userSnapshot.data()
              ?.stripeCustomerId
          : null;

      const sessionParams = {
        mode: "subscription",
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
      };

      if (
        existingCustomerId &&
        existingCustomerId.startsWith("cus_")
      ) {
        sessionParams.customer =
          existingCustomerId;
      } else {
        sessionParams.customer_email =
          email;
      }

      const session =
        await stripe.checkout.sessions.create(
          sessionParams
        );

      return res.json({
        success: true,
        checkoutUrl: session.url,
        sessionId: session.id,
        plan: normalizedPlan,
        maxBots:
          getMaxBots(normalizedPlan),
      });
    } catch (err) {
      console.error(
        "CREATE SUBSCRIPTION ERROR:",
        err
      );

      return res.status(500).json({
        success: false,
        message: err.message,
        type: err.type,
        code: err.code,
      });
    }
  }
);

/* ---------------- RÉSILIATION ABONNEMENT ---------------- */

/*
  L’en-tête Authorization doit contenir :
  Bearer <Firebase ID Token>

  La route ne demande pas subscriptionId :
  elle le récupère directement dans le document
  Firebase de l’utilisateur connecté.
*/
app.post(
  "/cancel-subscription",
  requireFirebaseAuth,
  async (req, res) => {
    try {
      const userId = req.user.uid;

      const userRef = db
        .collection("users")
        .doc(userId);

      const userSnapshot =
        await userRef.get();

      if (!userSnapshot.exists) {
        return res.status(404).json({
          success: false,
          error: "User document not found",
        });
      }

      const userData =
        userSnapshot.data();

      const subscriptionId =
        userData.subscriptionId;

      if (
        !subscriptionId ||
        !subscriptionId.startsWith("sub_")
      ) {
        return res.status(400).json({
          success: false,
          error:
            "No active Stripe subscription found",
        });
      }

      const subscription =
        await stripe.subscriptions.retrieve(
          subscriptionId
        );

      if (
        subscription.metadata?.userId !==
        userId
      ) {
        return res.status(403).json({
          success: false,
          error:
            "This subscription does not belong to this user",
        });
      }

      if (
        subscription.status === "canceled"
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Subscription is already cancelled",
        });
      }

      if (
        subscription.cancel_at_period_end
      ) {
        return res.json({
          success: true,
          alreadyScheduled: true,
          status: "cancelling",
          subscriptionId:
            subscription.id,
          cancelAt:
            subscription.cancel_at,
        });
      }

      const updatedSubscription =
        await stripe.subscriptions.update(
          subscriptionId,
          {
            cancel_at_period_end: true,
          }
        );

      await userRef.set(
        {
          subscriptionStatus: "cancelling",
          cancelAtPeriodEnd: true,
          subscriptionEndsAt:
            updatedSubscription.cancel_at
              ? admin.firestore.Timestamp.fromMillis(
                  updatedSubscription.cancel_at *
                    1000
                )
              : null,
        },
        { merge: true }
      );

      return res.json({
        success: true,
        status: "cancelling",
        subscriptionId:
          updatedSubscription.id,
        cancelAt:
          updatedSubscription.cancel_at,
        message:
          "Subscription will end at the end of the current billing period",
      });
    } catch (err) {
      console.error(
        "CANCEL SUBSCRIPTION ERROR:",
        err
      );

      return res.status(500).json({
        success: false,
        message: err.message,
        type: err.type,
        code: err.code,
      });
    }
  }
);

/* ---------------- PAGES DE RETOUR ---------------- */

app.get(
  "/subscription-success",
  (req, res) => {
    res.send(`
      <h1>Abonnement activé</h1>
      <p>Le paiement a été validé.</p>
      <p>Vous pouvez retourner dans Atlas Bot.</p>
    `);
  }
);

app.get(
  "/subscription-cancelled",
  (req, res) => {
    res.send(`
      <h1>Paiement annulé</h1>
      <p>Aucun abonnement n’a été créé.</p>
      <p>Vous pouvez retourner dans Atlas Bot.</p>
    `);
  }
);

/* ---------------- START SERVER ---------------- */

const PORT =
  process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(
    `Atlas Bot Stripe server running on port ${PORT}`
  );
});
