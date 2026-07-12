/** Closes the session event stream after the driver accepts terminal output. */
export async function closeSessionStreamStep(writable: WritableStream<Uint8Array>): Promise<void> {
  "use step";
  const writer = writable.getWriter();
  await writer.close();
}
