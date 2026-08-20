import express from "express";
import cors from "cors";
import helmet from "helmet";
import { connectionsRouter } from "./routes/connections.js";
import { introspectRouter } from "./routes/introspect.js";
import { previewRouter } from "./routes/preview.js";
import { executeRouter } from "./routes/execute.js";

export function createApp() {
    const app = express();

    app.use(helmet());
    app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
    app.use(express.json());

    app.get("/api/health", (_req, res) => res.json({ ok: true }));

    app.use("/api/connections", connectionsRouter);
    app.use("/api/connections", introspectRouter);
    app.use("/api/connections", previewRouter);
    app.use("/api/connections", executeRouter);

    return app;
}
