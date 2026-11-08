// The one place the real engine and the bundled model are wired in. Imported only by the route files under
// app/api/personalisation, so everything else in lib/server (and its tests) stays independent of them.
import { isValidRecommenderModel, recommend, type RecommenderModel } from "../../recommender/engine";
import { BUNDLED_DATASET, BUNDLED_METRICS, BUNDLED_MODEL } from "../../recommender/models";
import { getAppDatabase } from "../db/app-database";
import { createHandlers } from "./handlers";
import { createModelLoader, type BundledModel } from "./model-registry";
import { getAppSessionCodec } from "./session";

const bundled: BundledModel<RecommenderModel> = { model: BUNDLED_MODEL, dataset: BUNDLED_DATASET, metrics: BUNDLED_METRICS };

/** One set of handlers per server process. The database connection and secret are process singletons too. */
export const handlers = createHandlers<RecommenderModel>({
  getDb: () => getAppDatabase(),
  getCodec: getAppSessionCodec,
  recommend,
  loadModel: createModelLoader<RecommenderModel>({ bundled, validate: isValidRecommenderModel }),
});
