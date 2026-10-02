import express from "express";
import session from "express-session";
import cookieParser from "cookie-parser";
import path from "node:path";
import { config } from "./config";
import { attachLocals } from "./middleware/auth";
import { t, dirFor } from "./i18n";
import { authRouter } from "./routes/auth";
import { dashboardRouter } from "./routes/dashboard";
import { leaveRouter } from "./routes/leave";
import { approvalsRouter } from "./routes/approvals";
import { loansRouter } from "./routes/loans";
import { settingsRouter } from "./routes/settings";
import { reportsRouter } from "./routes/reports";

export function createApp(): express.Express {
  const app = express();

  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "..", "views"));
  app.locals.t = t;
  app.locals.dirFor = dirFor;

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, "..", "public")));
  app.use(
    "/vendor/bootstrap",
    express.static(path.join(__dirname, "..", "node_modules", "bootstrap", "dist"))
  );

  app.use(
    session({
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: config.isProduction,
        maxAge: config.sessionTimeoutMs,
      },
    })
  );

  // AUTH-07: sliding 30-minute inactivity timeout.
  app.use((req, res, next) => {
    const now = Date.now();
    if (req.session.user) {
      const last = req.session.lastActivityAt ?? now;
      if (now - last > config.sessionTimeoutMs) {
        req.session.destroy(() => {
          res.redirect("/login?timeout=1");
        });
        return;
      }
      req.session.lastActivityAt = now;
    }
    next();
  });

  app.use(attachLocals);

  app.use("/", authRouter);
  app.use("/", dashboardRouter);
  app.use("/", leaveRouter);
  app.use("/", approvalsRouter);
  app.use("/", loansRouter);
  app.use("/", settingsRouter);
  app.use("/", reportsRouter);

  app.use((_req, res) => {
    res.status(404).render("errors/404", { title: "Not found" });
  });

  return app;
}
