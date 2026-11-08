// Every migration, in order. Add new ones at the end; never edit or remove an applied one.
import type { Migration } from "../migrate";
import { migration0001 } from "./0001-initial";

export const MIGRATIONS: readonly Migration[] = [migration0001];
