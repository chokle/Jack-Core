import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import adminRouter from "./admin.js";
import videosRouter from "./videos.js";
import searchRouter from "./search.js";
import chatRouter from "./chat.js";
import competenciesRouter from "./competencies.js";
import graphRouter from "./graph.js";
import interviewRouter from "./interview.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(adminRouter);
router.use(videosRouter);
router.use(searchRouter);
router.use(chatRouter);
router.use(competenciesRouter);
router.use(graphRouter);
router.use(interviewRouter);

export default router;
