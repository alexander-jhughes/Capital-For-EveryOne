import { describe, expect, it } from "vitest";
import { LIMITS } from "./domain";
import { createSubject, forSubject, NO_CONSENT, type InputSnapshot, type NewRecommendation } from "./repository";
import { DAY, fakeModel, fakeRecommend, HOUR, prefs, T0, testDb } from "./test-helpers";

const MODEL = fakeModel().version;
const SNAPSHOT: InputSnapshot = { answers: { detailLevel: "keyFacts" }, preferences: prefs(), view: "simple", explicit: [], signals: {} };

/** A recommendation from the fake engine: main [textSize.125, contrast.high], alternative [spacing.roomy]. */
const newRec = (over: Partial<NewRecommendation> = {}): NewRecommendation => {
  const r = fakeRecommend(fakeModel(), { ...SNAPSHOT, history: [] });
  return { modelVersion: MODEL, configuration: r.configuration!, alternatives: r.alternatives, scores: r.scores, explanation: r.explanation, warnings: r.warnings, snapshot: SNAPSHOT, ...over };
};

const setup = () => {
  const db = testDb();
  const a = createSubject(db, T0);
  const b = createSubject(db, T0);
  return { db, a, b, repoA: forSubject(db, a), repoB: forSubject(db, b) };
};

describe("subjects and consent", () => {
  it("creates a pseudonymous subject with personalisation granted and records the consent", () => {
    const db = testDb();
    const id = createSubject(db, T0, { collaborative: true });
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const repo = forSubject(db, id);
    expect(repo.consent()).toEqual({ personalisation: true, collaborative: true, research: false });
    expect(db.prepare("SELECT kind, granted FROM consent_events WHERE subject_id = ? ORDER BY id").all(id)).toEqual([
      { kind: "personalisation", granted: 1 },
      { kind: "collaborative", granted: 1 },
    ]);
  });

  it("changes collaborative and research consent, recording only real changes", () => {
    const { db, a, repoA } = setup();
    repoA.setConsent({ collaborative: true, research: true }, T0 + 1);
    repoA.setConsent({ collaborative: true }, T0 + 2);
    expect(repoA.consent()).toEqual({ personalisation: true, collaborative: true, research: true });
    repoA.setConsent({ collaborative: false }, T0 + 3);
    expect(repoA.consent().collaborative).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS n FROM consent_events WHERE subject_id = ?").get(a) as { n: number }).n).toBe(4);
  });

  it("withdrawing research consent deletes the age band at once", () => {
    const { db, a, repoA } = setup();
    expect(repoA.saveResearch({ ageBand: "25-34" }, T0)).toBe(false);
    expect(repoA.research()).toBeNull();
    repoA.setConsent({ research: true }, T0);
    expect(repoA.saveResearch({ ageBand: "25-34" }, T0)).toBe(true);
    expect(repoA.research()).toEqual({ ageBand: "25-34" });
    repoA.setConsent({ research: false }, T0 + 1);
    expect(repoA.research()).toBeNull();
    expect(db.prepare("SELECT * FROM user_research WHERE subject_id = ?").all(a)).toEqual([]);
  });

  it("a missing age band deletes it", () => {
    const { repoA } = setup();
    repoA.setConsent({ research: true }, T0);
    repoA.saveResearch({ ageBand: "65+" }, T0);
    repoA.saveResearch({}, T0 + 1);
    expect(repoA.research()).toEqual({});
  });

  it("a deleted subject has no consent and no profile", () => {
    const { repoA } = setup();
    repoA.deleteAll();
    expect(repoA.exists()).toBe(false);
    expect(repoA.consent()).toEqual(NO_CONSENT);
    expect(repoA.profile()).toBeNull();
  });
});

describe("profile and settings", () => {
  it("replaces the answers", () => {
    const { repoA } = setup();
    repoA.saveAnswers({ detailLevel: "keyFacts", screenReader: "yes" }, T0);
    expect(repoA.saveAnswers({ inputMode: "voice" }, T0 + 1)).toEqual({ answers: { inputMode: "voice" }, answered: 1 });
    expect(repoA.profile()?.answers).toEqual({ inputMode: "voice" });
  });

  it("keeps explicit dimensions sticky: stored ∪ sent ∪ every non-default setting", () => {
    const { repoA } = setup();
    expect(repoA.savePreferences({ preferences: prefs({ textSize: 125 }), view: "simple", explicit: ["view"] }, T0).explicit).toEqual(["view", "textSize"]);
    // The client forgot everything and the text is back to normal: still explicit.
    expect(repoA.savePreferences({ preferences: prefs(), view: "complex", explicit: [] }, T0 + 1).explicit).toEqual(["view", "textSize"]);
    expect(repoA.savePreferences({ preferences: prefs({ contrast: "high" }), view: "complex", explicit: ["motion"] }, T0 + 2).explicit).toEqual([
      "view",
      "textSize",
      "contrast",
      "motion",
    ]);
    expect(repoA.preferences()).toMatchObject({ view: "complex", explicit: ["view", "textSize", "contrast", "motion"] });
  });

  it("sticky explicit dimensions go only when the subject is deleted", () => {
    const { db, repoA } = setup();
    repoA.savePreferences({ preferences: prefs({ textSize: 150 }), view: "simple", explicit: [] }, T0);
    repoA.deleteAll();
    const fresh = forSubject(db, createSubject(db, T0 + 1));
    expect(fresh.savePreferences({ preferences: prefs(), view: "simple", explicit: [] }, T0 + 2).explicit).toEqual([]);
  });
});

describe("signals", () => {
  it("stores allowlisted signals and counts them, capped per signal", () => {
    const { repoA } = setup();
    expect(repoA.addSignals(Array.from({ length: 15 }, () => ({ id: "textLarger" as const, source: "settings" as const })), T0)).toBe(15);
    repoA.addSignals([{ id: "voiceSessions", source: "voice" }], T0);
    expect(repoA.signalCounts(T0)).toEqual({ textLarger: 10, voiceSessions: 1 });
  });

  it("stops storing at the daily cap and starts again a day later", () => {
    const { repoA } = setup();
    const twenty = Array.from({ length: 20 }, () => ({ id: "moreDetail" as const, source: "dial" as const }));
    let stored = 0;
    for (let i = 0; i < 11; i++) stored += repoA.addSignals(twenty, T0 + i);
    expect(stored).toBe(LIMITS.signalsPerDay);
    expect(repoA.addSignals(twenty, T0 + HOUR)).toBe(0);
    expect(repoA.addSignals(twenty, T0 + DAY + HOUR)).toBe(20);
  });

  it("only counts signals inside the 180-day window", () => {
    const { repoA } = setup();
    repoA.addSignals([{ id: "textLarger", source: "settings" }], T0);
    expect(repoA.signalCounts(T0 + 179 * DAY)).toEqual({ textLarger: 1 });
    expect(repoA.signalCounts(T0 + 181 * DAY)).toEqual({});
  });
});

describe("recommendations", () => {
  it("re-uses an open, identical recommendation from the last 24 hours", () => {
    const { repoA } = setup();
    const first = repoA.recordRecommendation(newRec(), T0);
    expect(first.reused).toBe(false);
    expect(repoA.recordRecommendation(newRec(), T0 + HOUR)).toEqual({ id: first.id, reused: true });
    // A day later, a new one.
    expect(repoA.recordRecommendation(newRec(), T0 + 25 * HOUR).reused).toBe(false);
  });

  it("does not re-use one that has an answer, or a different suggestion", () => {
    const { repoA } = setup();
    const first = repoA.recordRecommendation(newRec(), T0);
    const other = newRec();
    other.configuration = { ...other.configuration, items: ["motion.reduced"] };
    expect(repoA.recordRecommendation(other, T0 + 1).reused).toBe(false);
    repoA.recordFeedback(first.id, { outcome: "dismissed" }, T0 + 2);
    expect(repoA.recordRecommendation(newRec(), T0 + 3).reused).toBe(false);
  });

  it("does not re-use another subject's recommendation", () => {
    const { repoA, repoB } = setup();
    const a = repoA.recordRecommendation(newRec(), T0);
    expect(repoB.recordRecommendation(newRec(), T0 + 1).id).not.toBe(a.id);
  });
});

describe("feedback", () => {
  const withRec = () => {
    const s = setup();
    return { ...s, rec: s.repoA.recordRecommendation(newRec(), T0).id };
  };

  it("accepts the whole suggestion, defaulting the items to the main configuration", () => {
    const { db, repoA, rec } = withRec();
    expect(repoA.recordFeedback(rec, { outcome: "accepted", via: "card" }, T0 + 1)).toEqual({ ok: true });
    expect(repoA.recommendation(rec)?.status).toBe("accepted");
    expect(db.prepare("SELECT items, via FROM recommendation_feedback").get()).toEqual({ items: '["textSize.125","contrast.high"]', via: "card" });
  });

  it("refuses 'accepted' with only part of it", () => {
    const { repoA, rec } = withRec();
    expect(repoA.recordFeedback(rec, { outcome: "accepted", items: ["textSize.125"] }, T0)).toMatchObject({ ok: false, status: 400 });
  });

  it("modified: a non-empty set from the configuration or alternatives, not the whole main configuration", () => {
    const { repoA, rec } = withRec();
    expect(repoA.recordFeedback(rec, { outcome: "modified", items: [] }, T0)).toMatchObject({ status: 400 });
    expect(repoA.recordFeedback(rec, { outcome: "modified", items: ["textSize.125", "contrast.high"] }, T0)).toMatchObject({ status: 400 });
    expect(repoA.recordFeedback(rec, { outcome: "modified", items: ["targets.large"] }, T0)).toMatchObject({ status: 400 });
    // Keeping the alternative instead is a modification.
    expect(repoA.recordFeedback(rec, { outcome: "modified", items: ["spacing.roomy"] }, T0)).toEqual({ ok: true });
    expect(repoA.recommendation(rec)?.status).toBe("modified");
  });

  it("items must belong to that recommendation", () => {
    const { repoA, rec } = withRec();
    expect(repoA.recordFeedback(rec, { outcome: "rejected", items: ["voiceFirst.on"] }, T0)).toMatchObject({ ok: false, status: 400 });
  });

  it("moves status only along allowed transitions", () => {
    const { repoA, rec } = withRec();
    expect(repoA.recordFeedback(rec, { outcome: "reverted" }, T0)).toMatchObject({ status: 409 });
    expect(repoA.recordFeedback(rec, { outcome: "modified", items: ["textSize.125"] }, T0 + 1)).toEqual({ ok: true });
    expect(repoA.recordFeedback(rec, { outcome: "accepted" }, T0 + 2)).toMatchObject({ status: 409 });
    expect(repoA.recordFeedback(rec, { outcome: "reverted", items: ["contrast.high"] }, T0 + 3)).toMatchObject({ status: 409 });
    expect(repoA.recordFeedback(rec, { outcome: "reverted", via: "undo" }, T0 + 4)).toEqual({ ok: true });
    expect(repoA.recommendation(rec)?.status).toBe("reverted");
    expect(repoA.recordFeedback(rec, { outcome: "reverted" }, T0 + 5)).toMatchObject({ status: 409 });
  });

  it("allows reverting kept items one at a time", () => {
    const { repoA, rec } = withRec();
    repoA.recordFeedback(rec, { outcome: "accepted" }, T0 + 1);
    expect(repoA.recordFeedback(rec, { outcome: "reverted", items: ["textSize.125"], via: "settings" }, T0 + 2)).toEqual({ ok: true });
    expect(repoA.recordFeedback(rec, { outcome: "reverted", items: ["textSize.125"] }, T0 + 3)).toMatchObject({ status: 409 });
    expect(repoA.recordFeedback(rec, { outcome: "reverted", items: ["contrast.high"], via: "reset" }, T0 + 4)).toEqual({ ok: true });
  });

  it("dismissed and rejected are final", () => {
    const { repoA, rec } = withRec();
    repoA.recordFeedback(rec, { outcome: "dismissed" }, T0 + 1);
    expect(repoA.recordFeedback(rec, { outcome: "rejected" }, T0 + 2)).toMatchObject({ status: 409 });
  });

  it("rating needs something kept, and a new rating replaces the old", () => {
    const { db, repoA, rec } = withRec();
    expect(repoA.rate(rec, 1, T0)).toMatchObject({ status: 409 });
    repoA.recordFeedback(rec, { outcome: "accepted" }, T0 + 1);
    expect(repoA.rate(rec, 1, T0 + 2)).toEqual({ ok: true });
    expect(repoA.rate(rec, -1, T0 + 3)).toEqual({ ok: true });
    expect(db.prepare("SELECT satisfaction FROM recommendation_feedback").all()).toEqual([{ satisfaction: -1 }]);
  });

  it("builds the engine's history from feedback, oldest first", () => {
    const { repoA, rec } = withRec();
    repoA.recordFeedback(rec, { outcome: "modified", items: ["spacing.roomy"] }, T0 + 1);
    repoA.recordFeedback(rec, { outcome: "reverted", via: "reset" }, T0 + 2);
    expect(repoA.historyFor()).toEqual([
      { item: "spacing.roomy", outcome: "accepted", at: T0 + 1 },
      { item: "textSize.125", outcome: "rejected", at: T0 + 1 },
      { item: "contrast.high", outcome: "rejected", at: T0 + 1 },
      // A reset says nothing about the item: a cooldown, not a rejection.
      { item: "spacing.roomy", outcome: "dismissed", at: T0 + 2 },
    ]);
    expect(repoA.historyFor(T0 + 2)).toHaveLength(3);
  });
});

describe("cross-subject isolation", () => {
  it("B can't see, answer, rate or export A's recommendation", () => {
    const { repoA, repoB } = setup();
    repoA.saveAnswers({ screenReader: "yes" }, T0);
    const rec = repoA.recordRecommendation(newRec(), T0).id;
    repoA.recordFeedback(rec, { outcome: "accepted" }, T0 + 1);

    expect(repoB.recommendation(rec)).toBeNull();
    expect(repoB.recordFeedback(rec, { outcome: "rejected" }, T0 + 2)).toEqual({ ok: false, status: 404, error: "Suggestion not found" });
    expect(repoB.recordFeedback(rec, { outcome: "reverted" }, T0 + 2)).toMatchObject({ status: 404 });
    expect(repoB.rate(rec, -1, T0 + 2)).toMatchObject({ status: 404 });
    expect(repoB.historyFor()).toEqual([]);
    const exportB = JSON.stringify(repoB.exportAll(T0));
    expect(exportB).not.toContain(rec);
    expect(exportB).not.toContain(repoA.subjectId);
    expect(exportB).not.toContain("screenReader");
    expect(repoA.recommendation(rec)?.status).toBe("accepted");
  });

  it("B deleting its data leaves A untouched", () => {
    const { repoA, repoB } = setup();
    repoA.recordRecommendation(newRec(), T0);
    repoB.deleteAll();
    expect(repoA.exists()).toBe(true);
    expect(repoA.exportAll(T0).recommendations).toHaveLength(1);
  });
});

describe("export", () => {
  it("contains everything about this subject, and only this subject", () => {
    const { repoA, repoB } = setup();
    repoA.setConsent({ research: true, collaborative: true }, T0);
    repoA.saveAnswers({ detailLevel: "everything" }, T0);
    repoA.saveResearch({ ageBand: "50-64" }, T0);
    repoA.savePreferences({ preferences: prefs({ textSize: 125 }), view: "simple", explicit: [] }, T0);
    repoA.addSignals([{ id: "voiceSessions", source: "voice" }], T0);
    const rec = repoA.recordRecommendation(newRec(), T0).id;
    repoA.recordFeedback(rec, { outcome: "accepted" }, T0 + 1);
    repoA.rate(rec, 1, T0 + 2);
    repoB.saveAnswers({ creditFamiliarity: "confident" }, T0);

    const out = repoA.exportAll(T0 + 3);
    expect(out.subject?.id).toBe(repoA.subjectId);
    expect(out.consent).toMatchObject({ personalisation: { granted: true }, collaborative: { state: "granted" }, research: { state: "granted" } });
    expect(out.profile?.answers).toEqual({ detailLevel: "everything" });
    expect(out.research?.ageBand).toBe("50-64");
    expect(out.settings?.explicitDimensions).toEqual(["textSize"]);
    expect(out.signals).toEqual([{ signal: "voiceSessions", source: "voice", at: new Date(T0).toISOString() }]);
    expect(out.recommendations).toHaveLength(1);
    expect(out.recommendations[0].feedback).toEqual([{ outcome: "accepted", items: ["textSize.125", "contrast.high"], via: null, satisfaction: 1, at: new Date(T0 + 1).toISOString() }]);
    expect(out.consentHistory.map((e) => e.kind)).toEqual(["personalisation", "collaborative", "research"]);
    expect(JSON.stringify(out)).not.toContain(repoB.subjectId);
    expect(JSON.stringify(out)).not.toContain("creditFamiliarity");
  });
});

describe("touch", () => {
  it("writes last_seen_at at most once per interval", () => {
    const { db, a, repoA } = setup();
    expect(repoA.touch(T0 + HOUR, DAY)).toBe(false);
    expect(repoA.touch(T0 + DAY, DAY)).toBe(true);
    expect(repoA.touch(T0 + DAY + 1, DAY)).toBe(false);
    expect((db.prepare("SELECT last_seen_at FROM subjects WHERE id = ?").get(a) as { last_seen_at: number }).last_seen_at).toBe(T0 + DAY);
  });
});

