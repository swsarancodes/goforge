import express from "express";
import cors from "cors";
import helmet from "helmet";
import { attachAuth, originGuard, requireAuth } from "./auth/middleware.js";
import { connectionsRouter } from "./routes/connections.js";
import { introspectRouter } from "./routes/introspect.js";
import { previewRouter } from "./routes/preview.js";
import { executeRouter } from "./routes/execute.js";
import { dataRouter } from "./routes/data.js";
import { relationsRouter } from "./routes/relations.js";
import { sqlRouter } from "./routes/sql.js";
import { aiRouter } from "./routes/ai.js";
import { modernizerRouter } from "./routes/modernizer.js";
import { schemaChangeRouter } from "./routes/schema-change.js";
import { aiGovernanceRouter } from "./routes/ai-governance.js";
import { authRouter } from "./routes/auth.js";
import { projectsRouter } from "./routes/projects.js";
import { createCloudDatabasesRouter, type CloudDatabaseDeps } from "./routes/cloud-databases.js";
import { errorHandler } from "./routes/async-handler.js";

export function createApp(options: { cloudDatabases?: CloudDatabaseDeps } = {}) {
    const app = express();

    // Behind nginx or another proxy the client address is in X-Forwarded-For; the sign-in rate limit needs the real one.
    if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : process.env.TRUST_PROXY);

    app.use(helmet());
    app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
    // A whole diagram is one request, so that route takes bigger bodies; this has to come before the general limit below.
    app.use("/api/projects", express.json({ limit: "25mb" }));
    app.use(express.json({ limit: "1mb" }));
    app.use(attachAuth);
    app.use(originGuard());

    app.get("/api/health", (_req, res) => res.json({ ok: true }));
    app.use("/api/auth", authRouter);

    // Everything below is for signed-in accounts when accounts are on, and open as before in local mode.
    app.use("/api", requireAuth);
    app.use("/api/projects", projectsRouter);
    app.use("/api/cloud-databases", createCloudDatabasesRouter(options.cloudDatabases));
    app.use("/api/connections", connectionsRouter);
    app.use("/api/connections", introspectRouter);
    app.use("/api/connections", previewRouter);
    app.use("/api/connections", executeRouter);
    app.use("/api/connections", dataRouter);
    app.use("/api/connections", relationsRouter);
    app.use("/api/connections", sqlRouter);
    app.use("/api/connections", modernizerRouter);
    app.use("/api/connections", schemaChangeRouter);
    app.use("/api/ai", aiGovernanceRouter);
    app.use("/api/ai", aiRouter);

    app.use(errorHandler);
    return app;
}
