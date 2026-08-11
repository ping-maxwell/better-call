import { Database } from "bun:sqlite";
import { describe, expect, it } from "vitest";
import { createBetterDB } from "./assemble";
import { prismaDriver } from "./driver";
import { prismaDb, testSchema } from "./helpers";
import {
	convertWhereClause,
	hasRootUniqueWhereCondition,
	operatorToPrismaOperator,
} from "./prisma";
import { createTestPrismaClient } from "./prisma-test-client";

describe("prisma where conversion", () => {
	it("maps operators to Prisma field filters", () => {
		expect(operatorToPrismaOperator("starts_with")).toBe("startsWith");
		expect(operatorToPrismaOperator("ends_with")).toBe("endsWith");
		expect(operatorToPrismaOperator("not_in")).toBe("notIn");
		expect(operatorToPrismaOperator("contains")).toBe("contains");
	});

	it("lifts eq fields for update WhereUniqueInput", () => {
		expect(
			convertWhereClause({
				action: "update",
				provider: "sqlite",
				where: [
					{
						field: "id",
						value: "u1",
						operator: "eq",
						connector: "AND",
						mode: "sensitive",
					},
					{
						field: "email",
						value: "ada@example.com",
						operator: "eq",
						connector: "AND",
						mode: "sensitive",
					},
				],
			}),
		).toEqual({ id: "u1", email: "ada@example.com" });
	});

	it("detects unique root where for update", () => {
		expect(
			hasRootUniqueWhereCondition(
				"user",
				[
					{
						field: "id",
						value: "u1",
						operator: "eq",
						connector: "AND",
						mode: "sensitive",
					},
				],
				"sqlite",
				testSchema,
			),
		).toBe(true);
		expect(
			hasRootUniqueWhereCondition(
				"user",
				[
					{
						field: "email",
						value: "ada@example.com",
						operator: "eq",
						connector: "AND",
						mode: "sensitive",
					},
				],
				"sqlite",
				testSchema,
			),
		).toBe(true);
		expect(
			hasRootUniqueWhereCondition(
				"user",
				[
					{
						field: "name",
						value: "Ada",
						operator: "eq",
						connector: "AND",
						mode: "sensitive",
					},
				],
				"sqlite",
				testSchema,
			),
		).toBe(false);
	});
});

describe("prismaDriver usage", () => {
	it("wires a Prisma-shaped client into createBetterDB", async () => {
		const raw = new Database(":memory:");
		const prisma = createTestPrismaClient(raw);
		const db = createBetterDB({
			driver: prismaDriver(prisma, { provider: "sqlite" }),
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

	it("updates through the prisma helper", async () => {
		const db = prismaDb(new Database(":memory:"));
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

	it("surfaces P2025 on guarded update as null", async () => {
		const db = prismaDb(new Database(":memory:"));
		await db.applySchema({ tables: testSchema });
		await db.create({
			model: "user",
			data: { id: "u1", name: "Ada", email: "ada@example.com", age: 36 },
		});

		const missed = await db.update({
			model: "user",
			where: [
				{ field: "id", value: "missing" },
				{ field: "email", value: "ada@example.com" },
			],
			update: { age: 37 },
		});
		expect(missed).toBeNull();
	});
});
