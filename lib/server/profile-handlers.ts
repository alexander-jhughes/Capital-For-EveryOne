// GET / PUT / DELETE /api/profile and POST /api/profile/usage. Every reply is JSON, never cached, and carries the whole
// view so the client can replace its copy. Nothing here can touch money: the profile store holds no account data.
import type { NeedId, PersonType } from "../profile/catalog";
import type { ProfileResult } from "../profile/infer";
import { profileModel } from "../profile/model";
import type { ProfileModel } from "../profile/train";
import { json } from "./handlers";
import { applyProfileChange, countUsage, emptyProfile, profileContext, profileStore, type ProfileRecord, type ProfileStore } from "./profile";
import { SessionSecretError } from "./secret";
import { sessionStore, type SessionStore } from "./store";

const MAX_BODY_BYTES = 2048;

/** What every profile route returns. */
export interface ProfileBody {
  consent: boolean;
  sensitiveConsent: boolean;
  needs: NeedId[];
  chosen: PersonType | null;
  /** null without consent, or when the model can't be used. */
  result: ProfileResult | null;
  saved: true;
}

const view = (record: ProfileRecord, result: ProfileResult | null): ProfileBody => ({
  consent: record.consent,
  sensitiveConsent: record.sensitiveConsent,
  needs: record.needs,
  chosen: record.chosen,
  result: record.consent ? result : null,
  saved: true,
});

async function readJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return undefined;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createProfileHandlers({ profiles = profileStore, sessions = sessionStore, model }: { profiles?: ProfileStore; sessions?: SessionStore; model?: ProfileModel | null } = {}) {
  const deps = () => ({ profiles, sessions, model: model === undefined ? profileModel() : model });

  const guarded =
    (run: (request: Request) => Promise<Response>) =>
    async (request: Request): Promise<Response> => {
      try {
        return await run(request);
      } catch (err) {
        if (err instanceof SessionSecretError) return json({ error: "The server can't keep your profile yet: SESSION_SECRET isn't set." }, 500);
        console.warn("[profile] request failed");
        return json({ error: "Sorry, something went wrong. Please try again." }, 500);
      }
    };

  /** The view for a record just saved: the cookie isn't on this request yet, so the record is passed in. */
  const viewOf = async (record: ProfileRecord, request: Request) => {
    if (!record.consent) return view(record, null);
    const fixed: ProfileStore = { load: async () => record, save: profiles.save };
    return view(record, (await profileContext(request, { ...deps(), profiles: fixed }))?.result ?? null);
  };

  return {
    get: guarded(async (request) => {
      const record = (await profiles.load(request)) ?? emptyProfile();
      return json(await viewOf(record, request));
    }),

    put: guarded(async (request) => {
      const body = await readJson(request);
      const current = (await profiles.load(request)) ?? emptyProfile();
      const change = applyProfileChange(current, body);
      if (!change.ok) return json({ error: change.message }, 400);
      const headers = await profiles.save(change.record, request);
      return json(await viewOf(change.record, request), 200, headers);
    }),

    delete: guarded(async (request) => {
      const headers = await profiles.save(emptyProfile(), request);
      return json(view(emptyProfile(), null), 200, headers);
    }),

    /** POST { kind }. Without consent nothing is counted and nothing is stored: `counted` says which. */
    usage: guarded(async (request) => {
      const body = (await readJson(request)) as { kind?: unknown } | undefined;
      const current = await profiles.load(request);
      const next = current && countUsage(current, body?.kind);
      if (!next) return json({ counted: false });
      return json({ counted: true }, 200, await profiles.save(next, request));
    }),
  };
}

export const profileHandlers = createProfileHandlers();
