type VercelSandboxModule = typeof import("#compiled/@vercel/sandbox/index.js");

interface CleanupOptions {
  readonly hosted?: boolean;
  readonly loadSandboxModule?: () => Promise<VercelSandboxModule>;
}

/** Deletes persistent Vercel sandboxes owned by one cancelled child session. */
export async function cleanupCancelledSubagentSandbox(
  sessionId: string,
  options: CleanupOptions = {},
): Promise<void> {
  if ((options.hosted ?? Boolean(process.env.VERCEL)) === false) return;

  const { Sandbox, Snapshot } = await (
    options.loadSandboxModule ??
    (async () => await import("#compiled/@vercel/sandbox/index.js"))
  )();
  const listed = await Sandbox.list({ limit: 50, tags: { sessionId } });
  const sandboxes = await listed.toArray();

  for (const sandbox of sandboxes) {
    if (sandbox.tags?.sessionId !== sessionId || sandbox.name.startsWith("eve-sbx-tpl-")) {
      continue;
    }
    const live = await Sandbox.get({ name: sandbox.name, resume: false });
    const snapshots = await (await live.listSnapshots({ limit: 50 })).toArray();
    await live.delete();
    for (const snapshot of snapshots) {
      if (snapshot.status !== "created") continue;
      await (await Snapshot.get({ snapshotId: snapshot.id })).delete();
    }
  }
}
