const enabled = ["1", "true"].includes((process.env.DEBUG || "").trim());

module.exports = enabled
  ? (...args) => console.log("[DEBUG]", ...args)
  : () => {};
