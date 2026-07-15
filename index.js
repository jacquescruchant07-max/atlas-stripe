require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

const app = express();

app.use(cors());
app.use(express.json());

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY is missing");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY.trim());

// Vérification du serveur
app.get("/", (req, res) => {
  res.json({
    status: "Atlas Bot Stripe server running",
    hasStripeKey: Boolean(process.env.STRIPE_SECRET_KEY),
    keyPrefix: process.env.STRIPE_SECRET_KEY.slice(0, 7),
  });
});

// Test de connexion Stripe
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

// Création d'un compte Stripe Connect
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
      refresh_url: "https://atlas-stripe.onrender.com",
      return_url: "https://atlas-stripe.onrender.com",
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

// Création d'une session d'abonnement vendeur
app.post("/create-seller-subscription", async (req, res) => {
  try {
    const { email, userId, plan } = req.body;

    if (!email || !userId || !plan) {
      return res.status(400).json({
        success: false,
        error: "email, userId and plan are required",
      });
    }

    const priceIds = {
      starter: process.env.STRIPE_PRICE_STARTER,
      pro: process.env.STRIPE_PRICE_PRO,
      business: process.env.STRIPE_PRICE_BUSINESS,
    };

    const priceId = priceIds[plan];

    if (!priceId) {
      return res.status(400).json({
        success: false,
        error: "Invalid plan",
      });
    }

    const session = await stripe.checkout.sessions.create({
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
        plan,
      },
      subscription_data: {
        metadata: {
          userId,
          plan,
        },
      },
    });

    res.json({
      success: true,
      checkoutUrl: session.url,
      sessionId: session.id,
    });
  } catch (err) {
    console.error("CREATE SUBSCRIPTION ERROR:", err);

    res.status(500).json({
      success: false,
      message: err.message,
      type: err.type,
      code: err.code,
    });
  }
});

// Pages temporaires après paiement
app.get("/subscription-success", (req, res) => {
  res.send(
    "<h1>Abonnement activé</h1><p>Vous pouvez retourner dans Atlas Bot.</p>"
  );
});

app.get("/subscription-cancelled", (req, res) => {
  res.send(
    "<h1>Paiement annulé</h1><p>Aucun abonnement n’a été créé.</p>"
  );
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`Atlas Bot Stripe server running on port ${PORT}`);
});
