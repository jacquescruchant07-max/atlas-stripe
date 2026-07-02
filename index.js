require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

const app = express();

app.use(cors());
app.use(express.json());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.get("/", (req, res) => {
  res.send("Atlas Bot Stripe server is running");
});

app.post("/create-connect-account", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        error: "Email is required",
      });
    }

    const account = await stripe.accounts.create({
      type: "express",
      country: "FR",
      email: email,
    });

    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: "https://atlasbot.app/stripe-refresh",
      return_url: "https://atlasbot.app/stripe-return",
      type: "account_onboarding",
    });

    res.status(200).json({
      success: true,
      accountId: account.id,
      onboardingUrl: accountLink.url,
    });

  } catch (err) {
    console.error("Stripe Error:", err);

    res.status(500).json({
      success: false,
      error: err.message,
      type: err.type,
      code: err.code,
    });
  }
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`Atlas Bot Stripe server running on port ${PORT}`);
});