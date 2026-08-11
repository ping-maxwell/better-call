import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { describe, expect, it } from "vitest";
import { createBetterDB } from "./assemble";
import { drizzleDriver } from "./driver";
import { getAffectedRowCount } from "./drizzle";
import { drizzleDb, testDrizzleTables, testSchema } from "./helpers";

describe("drizzle getAffectedRowCount", () => {
	it("reads sqlite changes", () => {
		expect(getAffectedRowCount({ changes: 3 })).toBe(3);
	});
});

describe("drizzleDriver usage", () => {
	it("wires bun-sqlite + drizzle schema into createBetterDB", async () => {
		const raw = new Database(":memory:");
		const orm = drizzle({ client: raw, schema: testDrizzleTables });
		const db = createBetterDB({
			driver: drizzleDriver(orm, {
				schema: testDrizzleTables,
				provider: "sqlite",
			}),
			schema: testSchema,
		});

		await db.applySchema({ tables: testSchema });
		const user = await db.create({
			model: "user",
			data: { name: "Ada", email: "ada@example.com" },
		});

		expect(user).toMatchObject({ name: "Ada", email: "ada@example.com" });
		expect(
			await db.findOne({
				model: "user",
				where: [{ field: "email", value: "ada@example.com" }],
			}),
		).toMatchObject({ id: user.id, name: "Ada" });
	});

	it("updates through the drizzle helper", async () => {
		const db = drizzleDb(new Database(":memory:"));
		await db.applySchema({ tables: testSchema });

		const user = await db.create({
			model: "user",
			data: { name: "Bob", email: "bob@example.com", age: 20 },
		});
		const updated = await db.update({
			model: "user",
			where: [{ field: "id", value: user.id }],
			update: { age: 21 },
		});

		expect(updated?.age).toBe(21);
	});
});
