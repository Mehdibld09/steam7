import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";

const router: IRouter = Router();

router.get("/healthz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    const data = HealthCheckResponse.parse({ status: "ok" });
    res.json(data);
  } catch (err: any) {
    const code = typeof err?.code === "string" ? err.code : "";
    const connectionError = [
      "28P01",
      "08001",
      "08003",
      "08004",
      "08006",
      "ECONNREFUSED",
      "ECONNRESET",
      "ENETUNREACH",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ETIMEDOUT",
    ].includes(code);

    res.status(503).json({
      status: "degraded",
      database: connectionError ? "unavailable" : "error",
    });
  }
});

export default router;
