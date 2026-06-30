import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import videosRouter from "./videos.js";
import searchRouter from "./search.js";
import chatRouter from "./chat.js";
import competenciesRouter from "./competencies.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(videosRouter);
router.use(searchRouter);
router.use(chatRouter);
router.use(competenciesRouter);

export default router;
