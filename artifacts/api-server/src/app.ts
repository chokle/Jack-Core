import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { publish } from "./lib/vitality";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Report meaningful (non-GET) API activity to the Vitality Engine so the
// heartbeat widget reflects real request load. GET/HEAD/OPTIONS (browsing,
// polling — including the widget's own poll — and CORS preflight) are excluded
// so idle traffic never registers as "busy".
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return next();
  }
  publish({ type: "request:start" });
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    publish({ type: "request:end" });
  };
  res.on("finish", end);
  res.on("close", end);
  next();
});

app.use("/api", router);

export default app;
