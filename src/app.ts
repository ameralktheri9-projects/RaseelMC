import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import cookieParser from "cookie-parser";
import path from "node:path";
import { config } from "./config";
import { pool } from "./db";
import { attachLocals } from "./middleware/auth";
import { t, dirFor } from "./i18n";
import { authRouter } from "./routes/auth";
import { dashboardRouter } from "./routes/dashboard";
import { leaveRouter } from "./routes/leave";
import { approvalsRouter } from "./routes/approvals";
import { loansRouter } from "./routes/loans";
import { settingsRouter } from "./routes/settings";
import { reportsRouter } from "./routes/reports";
import { notificationsRouter } from "./routes/notifications";

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

  const PgSession = connectPgSimple(session);
  app.use(
    session({
      store: new PgSession({ pool, tableName: "user_sessions", createTableIfMissing: true }),
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
  app.use("/", notificationsRouter);

  app.use((_req, res) => {
    res.status(404).render("errors/404", { title: "Not found" });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).render("errors/500", { title: "Error", lang: "en" });
  });

  return app;
}
