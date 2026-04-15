export function assert(condition: unknown, message = 'Assertion failed'): void {
  if (!condition) {
    throw new Error(message);
  }
}

export function assertEquals<T>(
  actual: T,
  expected: T,
  message = `Expected ${JSON.stringify(expected)} but got ${
    JSON.stringify(actual)
  }`,
): void {
  if (!deepEqual(actual, expected)) {
    throw new Error(message);
  }
}

export async function assertJson(
  response: Response,
  status: number,
): Promise<Record<string, unknown>> {
  assertEquals(
    response.status,
    status,
    `Expected status ${status} but got ${response.status}`,
  );
  return await response.json();
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
