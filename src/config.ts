import "dotenv/config";

export const config = {
  port: Number(process.env.PORT) || 3000,
  sessionSecret: process.env.SESSION_SECRET || "raseel-mc-dev-secret-change-me",
  sessionTimeoutMs: 30 * 60 * 1000, // AUTH-07: 30 minutes
  lockoutThreshold: 5, // AUTH-05
  lockoutDurationMs: 15 * 60 * 1000, // AUTH-05
  passwordExpiryDays: 90, // AUTH-04 default, configurable later
  attachmentsDir: process.env.ATTACHMENTS_DIR || "data/attachments",
  maxAttachmentBytes: 5 * 1024 * 1024, // LV-12: 5MB
  isProduction: process.env.NODE_ENV === "production",
};
