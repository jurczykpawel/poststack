/** Extract a deliberately conservative PostgreSQL database identifier from a connection URL. */
export function databaseNameFromUrl(connectionString: string): string {
  const name = decodeURIComponent(new URL(connectionString).pathname.slice(1));
  if (!/^[A-Za-z_][A-Za-z0-9_]*_e2e$/.test(name)) {
    throw new Error("E2E database URL must end with a simple PostgreSQL database name suffixed _e2e");
  }
  return name;
}

export function quoteDatabaseName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error("Invalid PostgreSQL database name");
  }
  return `"${name}"`;
}
