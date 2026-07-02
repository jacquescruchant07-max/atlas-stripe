require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

const app = express();
app.use(cors());
app.use(express.json());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.get("/", (req, res) => {
  res.json({
    status: "Atlas Bot Stripe server running",
    hasStripeKey: !!process.env.STRIPE_SECRET_KEY,
    keyPrefix: process.env.STRIPE_SECRET_KEY?.slice(0, 7),
  });
});

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

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {app.get("/debug-stripe", async (req, res) => {
  try {
    const balance = await stripe.balance.retrieve();
    res.json({
      success: true,
      balance,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: err.message,
      type: err.type,
      code: err.code,
    });
  }
});
  console.log(`Atlas Bot Stripe server running on port ${PORT}`);
});