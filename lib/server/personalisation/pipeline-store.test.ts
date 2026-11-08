import { describe, expect, it } from "vitest";
import type { ItemId } from "../../recommender/catalog";
import type { EligibilityCriteria, TrainingExample } from "../../recommender/types";
import type { Database } from "../db/sqlite";
import {
  activateModel,
  exportEligibleTrainingData,
  getActiveModelRecord,
  getModelRecord,
  listModels,
  monitoringSnapshot,
  purgeExpired,
  registerDataset,
  registerModel,
  rejectModel,
  rollbackModel,
  type ModelRecordInput,
} from "./pipeline-store";
import { createSubject, forSubject, type FeedbackInput, type InputSnapshot, type SubjectRepository } from "./repository";
import { DAY, fakeDataset, fakeModel, fakeRecommend, HOUR, prefs, T0, testDb } from "./test-helpers";

const CRITERIA: EligibilityCriteria = { requireCollaborativeConsent: true, minAgeHours: 24, maxAgeDays: 365, maxExamplesPerSubject: 50 };
const MODEL = fakeModel().version;
const NOW = T0 + 30 * DAY;

const snapshot = (over: Partial<InputSnapshot> = {}): InputSnapshot => ({ answers: { detailLevel: "keyFacts" }, preferences: prefs(), view: "simple", explicit: [], signals: { textLarger: 2 }, ...over });

/** Stores a recommendation at `at`: main [textSize.125, contrast.high], alternative [spacing.roomy] unless overridden. */
function addRec(repo: SubjectRepository, at: number, opts: { items?: ItemId[]; snapshot?: InputSnapshot } = {}): string {
  const r = fakeRecommend(fakeModel(), { ...snapshot(), history: [] });
  const configuration = opts.items ? { ...r.configuration!, items: opts.items } : r.configuration!;
  return repo.recordRecommendation(
    { modelVersion: MODEL, configuration, alternatives: r.alternatives, scores: r.scores, explanation: r.explanation, warnings: [], snapshot: opts.snapshot ?? snapshot() },
    at,
  ).id;
}

function answer(repo: SubjectRepository, id: string, input: FeedbackInput, at: number) {
  expect(repo.recordFeedback(id, input, at)).toEqual({ ok: true });
}

const consenting = (db: Database, at = T0) => forSubject(db, createSubject(db, at, { collaborative: true }));

const labelsOf = (examples: TrainingExample[]) => examples.map((e) => [e.item, e.label]).sort();

describe("exportEligibleTrainingData: labels", () => {
  type Act = (r: SubjectRepository, id: string, t: number) => void;
  const cases: [string, Act, [string, number][]][] = [
    ["accepted", (r, id, t) => answer(r, id, { outcome: "accepted" }, t), [["contrast.high", 1], ["textSize.125", 1]]],
    // Unticked one main item: kept → 1, the main item left out → 0.
    ["modified (unticked)", (r, id, t) => answer(r, id, { outcome: "modified", items: ["textSize.125"] }, t), [["contrast.high", 0], ["textSize.125", 1]]],
    // Kept the alternative instead: alternative → 1, main items → 0.
    ["modified (alternative)", (r, id, t) => answer(r, id, { outcome: "modified", items: ["spacing.roomy"] }, t), [["contrast.high", 0], ["spacing.roomy", 1], ["textSize.125", 0]]],
    ["rejected", (r, id, t) => answer(r, id, { outcome: "rejected" }, t), [["contrast.high", 0], ["textSize.125", 0]]],
    [
      "reverted via undo",
      (r, id, t) => {
        answer(r, id, { outcome: "accepted" }, t);
        answer(r, id, { outcome: "reverted", items: ["textSize.125"], via: "undo" }, t + 1);
      },
      [["contrast.high", 1], ["textSize.125", 0]],
    ],
    [
      "reverted via settings",
      (r, id, t) => {
        answer(r, id, { outcome: "accepted" }, t);
        answer(r, id, { outcome: "reverted", items: ["contrast.high"], via: "settings" }, t + 1);
      },
      [["contrast.high", 0], ["textSize.125", 1]],
    ],
    [
      "one item reverted via reset: no label for it",
      (r, id, t) => {
        answer(r, id, { outcome: "accepted" }, t);
        answer(r, id, { outcome: "reverted", items: ["contrast.high"], via: "reset" }, t + 1);
      },
      [["textSize.125", 1]],
    ],
    [
      "rated -1",
      (r, id, t) => {
        answer(r, id, { outcome: "accepted" }, t);
        expect(r.rate(id, -1, t + 1)).toEqual({ ok: true });
      },
      [["contrast.high", 0], ["textSize.125", 0]],
    ],
    [
      "rated +1",
      (r, id, t) => {
        answer(r, id, { outcome: "modified", items: ["contrast.high"] }, t);
        expect(r.rate(id, 1, t + 1)).toEqual({ ok: true });
      },
      [["contrast.high", 1], ["textSize.125", 0]],
    ],
  ];

  it.each(cases)("labels %s exactly as CONTRACT.md §8 says", (_name, act, expected) => {
    const db = testDb();
    const r = consenting(db);
    const id = addRec(r, T0 + DAY);
    act(r, id, T0 + DAY + 1);
    expect(labelsOf(exportEligibleTrainingData(db, CRITERIA, NOW).examples)).toEqual(expected);
  });

  it("gives no label for 'Not now' or for everything undone by a reset, and counts them", () => {
    const db = testDb();
    const repo = consenting(db);
    answer(repo, addRec(repo, T0), { outcome: "dismissed" }, T0 + 1);
    const reset = addRec(repo, T0 + 2, { items: ["motion.reduced"] });
    answer(repo, reset, { outcome: "accepted" }, T0 + 3);
    answer(repo, reset, { outcome: "reverted", via: "reset" }, T0 + 4);
    const out = exportEligibleTrainingData(db, CRITERIA, NOW);
    expect(out.examples).toEqual([]);
    expect(out.subjects).toBe(0);
    expect(out.excluded).toMatchObject({ no_label: 2, reset: 1 });
    expect(out.sourcePeriod).toEqual({ from: null, to: null });
  });

  it("ignores recommendations nobody has answered yet", () => {
    const db = testDb();
    const repo = consenting(db);
    addRec(repo, T0);
    const out = exportEligibleTrainingData(db, CRITERIA, NOW);
    expect(out.examples).toEqual([]);
    expect(Object.values(out.excluded).every((n) => n === 0)).toBe(true);
  });
});

describe("exportEligibleTrainingData: eligibility", () => {
  it("includes only people with personalisation and collaborative consent now", () => {
    const db = testDb();
    const yes = consenting(db);
    const never = forSubject(db, createSubject(db, T0));
    const withdrew = consenting(db);
    const declined = forSubject(db, createSubject(db, T0, { collaborative: false }));
    for (const r of [yes, never, withdrew, declined]) answer(r, addRec(r, T0), { outcome: "accepted" }, T0 + 1);
    withdrew.setConsent({ collaborative: false }, T0 + 2 * DAY);

    const out = exportEligibleTrainingData(db, CRITERIA, NOW);
    expect(out.subjects).toBe(1);
    expect(out.examples).toHaveLength(2);
    expect(out.excluded.no_consent).toBe(3);
  });

  it("drops a person at once when they turn personalisation off", () => {
    const db = testDb();
    const r = consenting(db);
    answer(r, addRec(r, T0), { outcome: "accepted" }, T0 + 1);
    expect(exportEligibleTrainingData(db, CRITERIA, NOW).examples).toHaveLength(2);
    r.deleteAll();
    const out = exportEligibleTrainingData(db, CRITERIA, NOW);
    expect(out.examples).toEqual([]);
    expect(out.excluded.no_consent).toBe(0); // nothing left to count
  });

  it("keeps only answers at least minAgeHours and at most maxAgeDays old", () => {
    const db = testDb(T0 - 400 * DAY);
    const r = consenting(db, T0 - 400 * DAY);
    answer(r, addRec(r, NOW - 2 * HOUR), { outcome: "accepted" }, NOW - HOUR); // too new
    answer(r, addRec(r, NOW - 25 * HOUR, { items: ["motion.reduced"] }), { outcome: "accepted" }, NOW - 25 * HOUR); // just old enough
    answer(r, addRec(r, NOW - 366 * DAY, { items: ["targets.large"] }), { outcome: "rejected" }, NOW - 366 * DAY); // too old
    const out = exportEligibleTrainingData(db, CRITERIA, NOW);
    expect(labelsOf(out.examples)).toEqual([["motion.reduced", 1]]);
    expect(out.excluded).toMatchObject({ too_new: 1, too_old: 1 });
    expect(out.sourcePeriod).toEqual({ from: new Date(NOW - 25 * HOUR).toISOString(), to: new Date(NOW - 25 * HOUR).toISOString() });
  });

  it("caps examples per person, keeping the newest", () => {
    const db = testDb();
    const r = consenting(db);
    for (let i = 0; i < 30; i++) answer(r, addRec(r, T0 + i * HOUR, { snapshot: snapshot({ signals: { textLarger: (i % 10) + 1, moreDetail: Math.floor(i / 10) + 1 } }) }), { outcome: "accepted" }, T0 + i * HOUR + 1);
    const out = exportEligibleTrainingData(db, { ...CRITERIA, maxExamplesPerSubject: 50 }, NOW);
    expect(out.examples).toHaveLength(50);
    expect(out.excluded.over_cap).toBe(10);
    expect(out.sourcePeriod.from).toBe(new Date(T0 + 5 * HOUR + 1).toISOString());
  });

  it("drops duplicate examples", () => {
    const db = testDb();
    const r = consenting(db);
    // Two different suggestions made before either was answered: the same input, so textSize.125 → 0 twice.
    const a = addRec(r, T0);
    const b = addRec(r, T0 + 1, { items: ["textSize.125"] });
    answer(r, a, { outcome: "rejected" }, T0 + 2);
    answer(r, b, { outcome: "rejected" }, T0 + 3);
    const out = exportEligibleTrainingData(db, CRITERIA, NOW);
    expect(labelsOf(out.examples)).toEqual([["contrast.high", 0], ["textSize.125", 0]]);
    expect(out.excluded.duplicate).toBe(1);
  });

  it("counts records whose snapshot no longer validates", () => {
    const db = testDb();
    const r = consenting(db);
    const id = addRec(r, T0);
    answer(r, id, { outcome: "accepted" }, T0 + 1);
    db.prepare("UPDATE recommendations SET input_snapshot = ? WHERE id = ?").run(JSON.stringify({ ...snapshot(), answers: { detailLevel: "retired-option" } }), id);
    const out = exportEligibleTrainingData(db, CRITERIA, NOW);
    expect(out.examples).toEqual([]);
    expect(out.excluded.invalid).toBe(1);
  });

  it("rejects nonsense criteria", () => {
    expect(() => exportEligibleTrainingData(testDb(), { ...CRITERIA, maxExamplesPerSubject: 0 }, NOW)).toThrow(/criteria/);
  });
});

describe("exportEligibleTrainingData: privacy and point in time", () => {
  it("uses the stored snapshot and only earlier history, never today's profile", () => {
    const db = testDb();
    const r = consenting(db);
    r.saveAnswers({ detailLevel: "everything" }, T0);
    const first = addRec(r, T0, { snapshot: snapshot({ answers: { detailLevel: "keyFacts" } }) });
    answer(r, first, { outcome: "rejected" }, T0 + HOUR);
    const second = addRec(r, T0 + 2 * HOUR, { items: ["motion.reduced"], snapshot: snapshot({ answers: { detailLevel: "some" } }) });
    answer(r, second, { outcome: "accepted" }, T0 + 3 * HOUR);
    // Something answered later must not leak back into the second example's history.
    answer(r, addRec(r, T0 + 4 * HOUR, { items: ["targets.large"], snapshot: snapshot({ answers: {} }) }), { outcome: "rejected" }, T0 + 5 * HOUR);
    r.saveAnswers({ detailLevel: "everything", screenReader: "yes" }, T0 + 6 * HOUR);

    const out = exportEligibleTrainingData(db, CRITERIA, NOW);
    const motion = out.examples.find((e) => e.item === "motion.reduced")!;
    expect(motion.input.answers).toEqual({ detailLevel: "some" });
    expect(motion.input.history).toEqual([
      { item: "textSize.125", outcome: "rejected", at: T0 + HOUR },
      { item: "contrast.high", outcome: "rejected", at: T0 + HOUR },
    ]);
    const firstExamples = out.examples.filter((e) => e.input.answers.detailLevel === "keyFacts");
    expect(firstExamples).toHaveLength(2);
    expect(firstExamples.every((e) => e.input.history.length === 0)).toBe(true);
    expect(out.examples.every((e) => e.source === "real" && e.weight === 1)).toBe(true);
  });

  it("gives each person a fresh random id per export and never includes stored ids or research data", () => {
    const db = testDb();
    const a = consenting(db);
    const b = consenting(db);
    for (const r of [a, b]) {
      r.setConsent({ research: true }, T0);
      r.saveResearch({ ageBand: "65+" }, T0);
      answer(r, addRec(r, T0), { outcome: "accepted" }, T0 + 1);
    }
    const one = exportEligibleTrainingData(db, CRITERIA, NOW);
    const two = exportEligibleTrainingData(db, CRITERIA, NOW);
    const ids = (x: typeof one) => [...new Set(x.examples.map((e) => e.subject))];
    expect(ids(one)).toHaveLength(2);
    expect(ids(one).some((id) => ids(two).includes(id))).toBe(false);
    const text = JSON.stringify([one, two]);
    for (const stored of [a.subjectId, b.subjectId]) expect(text).not.toContain(stored);
    expect(text).not.toContain("65+");
    expect(text).not.toContain("ageBand");
    const recIds = (db.prepare("SELECT id FROM recommendations").all() as { id: string }[]).map((r) => r.id);
    for (const id of recIds) expect(text).not.toContain(id);
  });

  it("does not change the database", () => {
    const db = testDb();
    const r = consenting(db);
    answer(r, addRec(r, T0), { outcome: "accepted" }, T0 + 1);
    const before = db.prepare("SELECT COUNT(*) AS n FROM recommendations").get();
    exportEligibleTrainingData(db, CRITERIA, NOW);
    expect(db.prepare("SELECT COUNT(*) AS n FROM recommendations").get()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM learning_datasets").get()).toEqual({ n: 1 });
  });
});

describe("purgeExpired", () => {
  it("removes signals after 180 days, suggestions and feedback after 365, and people unseen for 400", () => {
    const start = T0 - 500 * DAY;
    const db = testDb(start);
    const r = forSubject(db, createSubject(db, start));
    r.touch(T0, 0);
    r.addSignals([{ id: "textLarger", source: "settings" }], T0 - 181 * DAY);
    r.addSignals([{ id: "textSmaller", source: "settings" }], T0 - 179 * DAY);
    const old = addRec(r, T0 - 366 * DAY);
    answer(r, old, { outcome: "accepted" }, T0 - 366 * DAY);
    const recent = addRec(r, T0 - 364 * DAY, { items: ["motion.reduced"] });
    answer(r, recent, { outcome: "accepted" }, T0 - 364 * DAY);
    const gone = forSubject(db, createSubject(db, T0 - 401 * DAY));
    const kept = forSubject(db, createSubject(db, T0 - 399 * DAY));

    const counts = purgeExpired(db, T0);
    expect(counts).toEqual({ interaction_signals: 1, recommendation_feedback: 1, recommendations: 1, subjects: 1 });
    expect(r.signalCounts(T0)).toEqual({ textSmaller: 1 });
    expect(r.recommendation(old)).toBeNull();
    expect(r.recommendation(recent)).not.toBeNull();
    expect(gone.exists()).toBe(false);
    expect(kept.exists()).toBe(true);
    expect(purgeExpired(db, T0)).toEqual({ interaction_signals: 0, recommendation_feedback: 0, recommendations: 0, subjects: 0 });
  });
});

describe("dataset and model registry", () => {
  const model = (version: string, over: Partial<ModelRecordInput> = {}): ModelRecordInput => ({
    version,
    datasetVersion: "syn-fake-1",
    algorithm: "hybrid",
    trainedOn: "synthetic",
    config: { seed: 1 },
    metrics: { auc: 0.7 },
    artifactPath: `.data/models/${version}.json`,
    artifactSha256: "c".repeat(64),
    sizeBytes: 1234,
    createdAt: T0,
    ...over,
  });

  it("registers datasets idempotently and refuses a changed one", () => {
    const db = testDb();
    registerDataset(db, fakeDataset("ds-2"));
    registerDataset(db, fakeDataset("ds-2"));
    expect(() => registerDataset(db, { ...fakeDataset("ds-2"), contentSha256: "d".repeat(64) })).toThrow(/different content/);
    expect(() => registerDataset(db, { ...fakeDataset("ds-3"), contentSha256: "nothex" })).toThrow(/Invalid/);
  });

  it("registers a model as a candidate, needing its dataset first", () => {
    const db = testDb();
    expect(() => registerModel(db, model("m2", { datasetVersion: "missing" }))).toThrow(/Register dataset/);
    registerModel(db, model("m2"));
    registerModel(db, model("m2"));
    expect(getModelRecord(db, "m2")).toMatchObject({ status: "candidate", rollbackTo: null, config: { seed: 1 }, metrics: { auc: 0.7 } });
    expect(() => registerModel(db, model("m2", { artifactSha256: "e".repeat(64) }))).toThrow(/different artifact/);
  });

  it("activates in one step: the old one retires and becomes the rollback target", () => {
    const db = testDb();
    const bundled = getActiveModelRecord(db)!.version;
    registerModel(db, model("m2"));
    activateModel(db, "m2", T0 + 1);
    expect(getActiveModelRecord(db)).toMatchObject({ version: "m2", activatedAt: T0 + 1, rollbackTo: bundled });
    expect(getModelRecord(db, bundled)).toMatchObject({ status: "retired", retiredAt: T0 + 1 });
    expect(listModels(db).filter((m) => m.status === "active")).toHaveLength(1);
    activateModel(db, "m2", T0 + 2); // already active: nothing changes
    expect(getActiveModelRecord(db)?.activatedAt).toBe(T0 + 1);
  });

  it("rolls back step by step without bouncing", () => {
    const db = testDb();
    const bundled = getActiveModelRecord(db)!.version;
    registerModel(db, model("m2"));
    registerModel(db, model("m3", { createdAt: T0 + 1 }));
    activateModel(db, "m2", T0 + 1);
    activateModel(db, "m3", T0 + 2);
    expect(rollbackModel(db, T0 + 3)).toBe("m2");
    expect(getModelRecord(db, "m3")?.status).toBe("retired");
    expect(rollbackModel(db, T0 + 4)).toBe(bundled);
    expect(() => rollbackModel(db, T0 + 5)).toThrow(/no earlier model/);
    expect(listModels(db).map((m) => m.version)).toEqual(["m3", "m2", bundled]);
  });

  it("never activates a rejected model, or an unknown one", () => {
    const db = testDb();
    registerModel(db, model("bad"));
    rejectModel(db, "bad", "failed the fairness gate");
    expect(getModelRecord(db, "bad")).toMatchObject({ status: "rejected", notes: "failed the fairness gate" });
    expect(() => activateModel(db, "bad", T0)).toThrow(/rejected/);
    expect(() => activateModel(db, "nope", T0)).toThrow(/Unknown/);
  });
});

describe("monitoringSnapshot", () => {
  it("reports aggregates only, with no subject or recommendation ids", () => {
    const db = testDb();
    const a = consenting(db);
    const b = forSubject(db, createSubject(db, T0));
    const r1 = addRec(a, T0, { snapshot: snapshot({ answers: { detailLevel: "keyFacts", inputMode: "voice" }, preferences: prefs({ textSize: 150 }) }) });
    answer(a, r1, { outcome: "modified", items: ["textSize.125"] }, T0 + 1);
    a.rate(r1, 1, T0 + 2);
    const r2 = addRec(b, T0, { snapshot: snapshot({ view: "complex", explicit: ["contrast"] }) });
    answer(b, r2, { outcome: "rejected" }, T0 + 1);
    const r3 = addRec(b, T0 + 2, { items: ["motion.reduced"] });
    answer(b, r3, { outcome: "accepted" }, T0 + 3);
    answer(b, r3, { outcome: "reverted", via: "undo" }, T0 + 4);
    addRec(a, T0 + 5, { items: ["targets.large"] }); // still open

    const m = monitoringSnapshot(db, T0 - DAY);
    expect(m.recommendations.total).toBe(4);
    expect(m.recommendations.byStatus).toMatchObject({ shown: 1, modified: 1, rejected: 1, reverted: 1, accepted: 0 });
    expect(m.recommendations.byModel).toEqual({ [MODEL]: 4 });
    expect(m.acceptance.overall).toEqual({ shown: 3, kept: 2, rate: 2 / 3 });
    expect(m.acceptance.byItem["textSize.125"]).toEqual({ shown: 2, kept: 1, rate: 0.5 });
    expect(m.acceptance.byItem["contrast.high"]).toEqual({ shown: 2, kept: 0, rate: 0 });
    expect(m.acceptance.byItem["motion.reduced"]).toEqual({ shown: 1, kept: 1, rate: 1 });
    expect(m.acceptance.byEvidence.moderate).toEqual({ shown: 3, kept: 2, rate: 2 / 3 });
    expect(m.acceptance.byEvidence.strong).toEqual({ shown: 0, kept: 0, rate: null });
    expect(m.acceptance.byRank[0]).toEqual({ shown: 2, kept: 1, rate: 0.5 });
    expect(m.feedback.byOutcome).toEqual({ accepted: 1, modified: 1, rejected: 1, dismissed: 0, reverted: 1 });
    expect(m.feedback.revertedVia.undo).toBe(1);
    expect(m.feedback.satisfaction).toEqual({ helpful: 1, neutral: 0, unhelpful: 0 });
    expect(m.inputs.snapshots).toBe(4);
    expect(m.inputs.answers.detailLevel).toMatchObject({ keyFacts: 4, skipped: 0 });
    expect(m.inputs.answers.inputMode).toMatchObject({ voice: 1, skipped: 3 });
    expect(m.inputs.activeItems).toMatchObject({ "textSize.125": 1, "textSize.150": 1, "view.simple": 3, "view.detailed": 1 });
    expect(m.inputs.view).toEqual({ simple: 3, complex: 1 });
    expect(m.inputs.explicit).toEqual({ contrast: 1 });

    const text = JSON.stringify(m);
    for (const id of [a.subjectId, b.subjectId, r1, r2, r3]) expect(text).not.toContain(id);
    expect(text).not.toMatch(/[0-9a-f]{32}/);
  });

  it("only looks at activity since the given time", () => {
    const db = testDb();
    const a = consenting(db);
    answer(a, addRec(a, T0), { outcome: "accepted" }, T0 + 1);
    expect(monitoringSnapshot(db, T0 + DAY).recommendations.total).toBe(0);
    expect(monitoringSnapshot(db, T0 + DAY).feedback.byOutcome.accepted).toBe(0);
  });
});
