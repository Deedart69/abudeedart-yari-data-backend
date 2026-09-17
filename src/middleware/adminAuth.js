// Protects admin-only routes (pricing management) with a single secret key
// you set yourself — separate from customer JWTs entirely, so a compromised
// customer account can never reach these routes.
function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

module.exports = { requireAdmin };
