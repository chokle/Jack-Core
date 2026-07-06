import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import meRouter from "./me.js";
import videosRouter from "./videos.js";
import searchRouter from "./search.js";
import chatRouter from "./chat.js";
import competenciesRouter from "./competencies.js";
import knowledgeRouter from "./knowledge.js";
import graphRouter from "./graph.js";
import interviewRouter from "./interview.js";
import parkingLotRouter from "./parking-lot.js";
import systemHealthRouter from "./system-health.js";
import testingRouter from "./testing.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(meRouter);
router.use(videosRouter);
router.use(searchRouter);
router.use(chatRouter);
router.use(competenciesRouter);
router.use(knowledgeRouter);
router.use(graphRouter);
router.use(interviewRouter);
router.use(parkingLotRouter);
router.use(systemHealthRouter);
router.use(testingRouter);

export default router;
