import type { Database } from "bun:sqlite";
import type { DrizzleClient, DrizzleProvider, DrizzleSchema } from "./drizzle";
import { drizzleStorage } from "./drizzle";
import { createMemoryClient, memoryStorage } from "./memory";
import type {
	PrismaClientHandle,
	PrismaClientLike,
	PrismaProvider,
} from "./prisma";
import { prismaStorage } from "./prisma";
import { sqliteStorage } from "./sqlite";

/** Wire codecs + feature flags owned by the storage driver — not app config. */
export type DriverCapabilities = {
	supportsJSON: boolean;
	supportsDates: boolean;
	supportsBooleans: boolean;
	supportsArrays: boolean;
	supportsJoins: boolean;
	supportsNumericIds: boolean;
	supportsUUIDs: boolean;
	/** When false, `db.transaction` runs the callback without begin/commit. */
	supportsTransactions: boolean;
};

export type Driver = {
	adapterId: string;
	adapterName?: string;
	storage: Record<string, unknown>;
	client: unknown;
	capabilities: DriverCapabilities;
};

const baseCapabilities = {
	supportsNumericIds: true,
	supportsUUIDs: true,
	supportsArrays: false,
} as const;

/** In-memory tables driver (JSON/bool/date native). */
export const memoryDriver = (): Driver => ({
	adapterId: "memory",
	adapterName: "Memory",
	storage: memoryStorage,
	client: createMemoryClient(),
	capabilities: {
		...baseCapabilities,
		supportsJSON: true,
		supportsDates: true,
		supportsBooleans: true,
		supportsJoins: false,
		supportsTransactions: true,
	},
});

/** bun:sqlite driver (JSON stored as text). */
export const sqliteDriver = (db: Database): Driver => ({
	adapterId: "sqlite",
	adapterName: "SQLite",
	storage: sqliteStorage,
	client: db,
	capabilities: {
		...baseCapabilities,
		supportsJSON: false,
		supportsDates: true,
		supportsBooleans: true,
		supportsJoins: false,
		supportsTransactions: true,
	},
});

export type DrizzleDriverConfig = {
	/** Drizzle table objects keyed by physical model name. */
	schema: DrizzleSchema;
	/**
	 * SQL dialect. Only `sqlite` is implemented; `pg` / `mysql` are reserved
	 * so call sites can already pass the right provider.
	 * @default "sqlite"
	 */
	provider?: DrizzleProvider;
};

const drizzleCapabilities = (provider: DrizzleProvider): DriverCapabilities => {
	if (provider === "pg") {
		return {
			supportsNumericIds: true,
			supportsUUIDs: true,
			supportsJSON: true,
			supportsDates: true,
			supportsBooleans: true,
			supportsArrays: true,
			supportsJoins: false,
			supportsTransactions: true,
		};
	}
	if (provider === "mysql") {
		return {
			supportsNumericIds: true,
			supportsUUIDs: false,
			supportsJSON: false,
			supportsDates: true,
			supportsBooleans: true,
			supportsArrays: false,
			supportsJoins: false,
			supportsTransactions: true,
		};
	}
	return {
		...baseCapabilities,
		supportsJSON: false,
		supportsDates: true,
		supportsBooleans: true,
		supportsJoins: false,
		supportsTransactions: true,
	};
};

/**
 * Drizzle ORM driver. Pass a drizzle instance plus its table schema.
 * SQLite is the only implemented provider today.
 */
export const drizzleDriver = (
	db: unknown,
	config: DrizzleDriverConfig,
): Driver => {
	const provider = config.provider ?? "sqlite";
	const client: DrizzleClient = {
		db,
		schema: config.schema,
		provider,
	};
	return {
		adapterId: "drizzle",
		adapterName: "Drizzle",
		storage: drizzleStorage,
		client,
		capabilities: drizzleCapabilities(provider),
	};
};

export type PrismaDriverConfig = {
	/**
	 * SQL / document dialect. Only `sqlite` implements begin/applyDDL today;
	 * other providers share the Prisma Client query surface.
	 * @default "sqlite"
	 */
	provider?: PrismaProvider;
};

const prismaCapabilities = (provider: PrismaProvider): DriverCapabilities => {
	if (provider === "postgresql" || provider === "mongodb") {
		return {
			supportsNumericIds: true,
			supportsUUIDs: provider === "postgresql",
			supportsJSON: true,
			supportsDates: true,
			supportsBooleans: true,
			supportsArrays: true,
			supportsJoins: false,
			supportsTransactions: true,
		};
	}
	if (provider === "mysql") {
		return {
			supportsNumericIds: true,
			supportsUUIDs: false,
			supportsJSON: false,
			supportsDates: true,
			supportsBooleans: true,
			supportsArrays: false,
			supportsJoins: false,
			supportsTransactions: true,
		};
	}
	return {
		...baseCapabilities,
		supportsJSON: false,
		supportsDates: true,
		supportsBooleans: true,
		supportsJoins: false,
		supportsTransactions: true,
	};
};

/**
 * Prisma ORM driver. Pass a generated Prisma Client (duck-typed).
 * SQLite is the only provider with begin/applyDDL today.
 */
export const prismaDriver = (
	prisma: PrismaClientLike,
	config: PrismaDriverConfig = {},
): Driver => {
	const provider = config.provider ?? "sqlite";
	const client: PrismaClientHandle = {
		prisma,
		provider,
	};
	return {
		adapterId: "prisma",
		adapterName: "Prisma",
		storage: prismaStorage,
		client,
		capabilities: prismaCapabilities(provider),
	};
};
