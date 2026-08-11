import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { BetterDBModule } from "./assemble";
import { createBetterDB } from "./assemble";
import {
	drizzleDriver,
	memoryDriver,
	prismaDriver,
	sqliteDriver,
} from "./driver";
import { createTestPrismaClient } from "./prisma-test-client";
import type { BetterAuthDBSchema } from "./types";

export const testSchema: BetterAuthDBSchema = {
	user: {
		fields: {
			name: { type: "string", required: true },
			email: { type: "string", unique: true, required: true },
			age: { type: "number", required: false },
			active: { type: "boolean", required: false, defaultValue: true },
		},
	},
	token: {
		fields: {
			value: { type: "string", required: true },
			remaining: { type: "number", required: true, defaultValue: 3 },
		},
	},
	session: {
		fields: {
			userId: {
				type: "string",
				required: true,
				references: { model: "user", field: "id" },
			},
			token: { type: "string", required: true },
		},
	},
};

/** Drizzle table objects matching {@link testSchema} physical names. */
export const testDrizzleTables = {
	user: sqliteTable("user", {
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		email: text("email").notNull().unique(),
		age: integer("age"),
		active: integer("active", { mode: "boolean" }),
	}),
	token: sqliteTable("token", {
		id: text("id").primaryKey(),
		value: text("value").notNull(),
		remaining: integer("remaining").notNull(),
	}),
	session: sqliteTable("session", {
		id: text("id").primaryKey(),
		userId: text("userId").notNull(),
		token: text("token").notNull(),
	}),
};

export const memoryDb = (
	schema: BetterAuthDBSchema = testSchema,
): BetterDBModule =>
	createBetterDB({
		driver: memoryDriver(),
		schema,
	});

export const sqliteDb = (
	db: Database,
	schema: BetterAuthDBSchema = testSchema,
): BetterDBModule =>
	createBetterDB({
		driver: sqliteDriver(db),
		schema,
	});

export const drizzleDb = (
	raw: Database,
	schema: BetterAuthDBSchema = testSchema,
	tables: typeof testDrizzleTables = testDrizzleTables,
): BetterDBModule =>
	createBetterDB({
		driver: drizzleDriver(drizzle({ client: raw, schema: tables }), {
			schema: tables,
			provider: "sqlite",
		}),
		schema,
	});

export const prismaDb = (
	raw: Database,
	schema: BetterAuthDBSchema = testSchema,
): BetterDBModule =>
	createBetterDB({
		driver: prismaDriver(createTestPrismaClient(raw), {
			provider: "sqlite",
		}),
		schema,
	});
