require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const walletRoutes = require("./routes/wallet");
const purchaseRoutes = require("./routes/purchase");

const app = express();
app.use(cors());

// The Paystack webhook needs the raw request body to verify its signature.
// This raw parser is scoped to just that path and runs BEFORE express.json();
// body-parser then skips re-parsing a request it's already handled, so the
// route below still gets the untouched Buffer it needs.
app.use("/api/wallet/webhook/paystack", express.raw({ type: "application/json" }));
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/purchase", purchaseRoutes);

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`DataDock backend running on port ${PORT}`));
