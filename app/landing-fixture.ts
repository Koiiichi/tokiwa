/** A fixed pair of session snapshots for tests and text captures. Every value is invented. */
import type { SessionRef } from "./backend";

const root = "/srv/development/state/workspaces";
const kit = `${root}/service-a-wt/fix-pr`;
const bench = `${root}/workbench`;
const screen = (seed: string) => seed.repeat(64).slice(0, 64);
const session = (
  name: string,
  project: string,
  clients: number,
  id: number,
  hash: string,
  extra: { bell?: boolean; dead?: boolean } = {},
): SessionRef => ({
  name,
  identity: `${1000 + id}:$${id}:${1767000000 + id}`,
  cwd: project,
  project,
  clients,
  activity: [
    {
      pane: `%${id}`,
      dead: extra.dead ?? false,
      command: "node",
      screen: screen(hash),
    },
  ],
  ...(extra.bell === undefined ? {} : { bell: extra.bell }),
});

/** The earlier snapshot. The view compares pane screens with it to observe output. */
export const landingPrevious: SessionRef[] = [
  session("web-lead", kit, 1, 1, "a"),
  session("coder-lead", kit, 0, 2, "b"),
  session("claude-test", bench, 0, 3, "c"),
  session("setup", bench, 0, 4, "d"),
  session("setup2", bench, 0, 5, "e"),
  session("tools", bench, 1, 6, "f"),
  session("nightly", bench, 0, 7, "g", { dead: true }),
];
/**
 * The current snapshot: web-lead and setup2 changed their screens since the earlier one,
 * coder-lead rang the bell, tools has a client elsewhere and every pane of nightly ended.
 * The earlier snapshot has no bell field, as from an older host helper.
 */
export const landingSessions: SessionRef[] = [
  session("web-lead", kit, 1, 1, "1", { bell: false }),
  session("coder-lead", kit, 0, 2, "b", { bell: true }),
  session("claude-test", bench, 0, 3, "c", { bell: false }),
  session("setup", bench, 0, 4, "d", { bell: false }),
  session("setup2", bench, 0, 5, "2", { bell: false }),
  session("tools", bench, 1, 6, "f", { bell: false }),
  session("nightly", bench, 0, 7, "g", { bell: false, dead: true }),
];
