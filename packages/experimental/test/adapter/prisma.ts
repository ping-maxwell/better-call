import { v } from "../../src";
import {
	storageApplyDDLInput,
	storageCountInput,
	storageCreateInput,
	storageDeleteInput,
	storageFindManyInput,
	storageFindOneInput,
	storageIncrementInput,
	storageUpdateInput,
} from "./schemas";
import type { BetterAuthDBSchema, CleanedWhere } from "./types";
import { adapterVars } from "./vars";

/**
 * Dialects the driver will grow into. Only `sqlite` implements begin/applyDDL
 * today; other providers share the same Prisma Client query surface.
 */
export type PrismaProvider =
	| "sqlite"
	| "postgresql"
	| "mysql"
	| "mongodb"
	| "cockroachdb"
	| "sqlserver";

/** Duck-typed Prisma Client — avoids a hard `@prisma/client` dependency. */
export type PrismaClientLike = {
	$transaction?: <T>(fn: (tx: PrismaClientLike) => Promise<T>) => Promise<T>;
	$executeRawUnsafe?: (sql: string, ...values: unknown[]) => Promise<unknown>;
	[model: string]: unknown;
};

/** Client stored on `c.client` for the prisma storage module. */
export type PrismaClientHandle = {
	prisma: PrismaClientLike;
	provider: PrismaProvider;
};

type Row = Record<string, any>;
type Delegate = {
	create: (args: any) => Promise<any>;
	findFirst: (args: any) => Promise<any>;
	findMany: (args: any) => Promise<any>;
	count: (args: any) => Promise<number>;
	update: (args: any) => Promise<any>;
	updateMany: (args: any) => Promise<{ count: number }>;
	delete: (args: any) => Promise<any>;
	deleteMany: (args: any) => Promise<{ count: number }>;
};

const storeUse = { use: [adapterVars] };

const isPrismaNotFoundError = (e: unknown): boolean =>
	typeof e === "object" &&
	e !== null &&
	"code" in e &&
	(e as { code: unknown }).code === "P2025";

const handleOf = (c: { client: unknown; trx: unknown }): PrismaClientHandle => {
	const client = c.client as PrismaClientHandle | null;
	if (!client?.prisma) {
		throw new Error("prisma storage: client var is not set");
	}
	return client;
};

/** Prefer the active transaction client when begin/commit has opened one. */
const dbOf = (c: { client: unknown; trx: unknown }): PrismaClientLike => {
	const trx = c.trx as { prisma?: PrismaClientLike } | null;
	if (trx?.prisma) return trx.prisma;
	return handleOf(c).prisma;
};

const inTransaction = (c: { trx: unknown }): boolean => c.trx != null;

const delegateOf = (db: PrismaClientLike, model: string): Delegate => {
	const delegate = db[model];
	if (
		!delegate ||
		typeof delegate !== "object" ||
		typeof (delegate as Delegate).create !== "function"
	) {
		throw new Error(
			`prisma storage: model "${model}" does not exist on the Prisma client. If you haven't generated the Prisma client, run 'npx prisma generate'.`,
		);
	}
	return delegate as Delegate;
};

const selectOf = (select?: string[]) => {
	if (!select?.length) return undefined;
	const out: Record<string, boolean> = {};
	out.id = true;
	for (const field of select) out[field] = true;
	return out;
};

const project = (row: Row | null | undefined, select?: string[]) => {
	if (!row) return null;
	if (!select?.length) return row;
	const out: Row = {};
	if ("id" in row) out.id = row.id;
	for (const s of select) out[s] = row[s];
	return out;
};

export const operatorToPrismaOperator = (operator: string): string => {
	switch (operator) {
		case "starts_with":
			return "startsWith";
		case "ends_with":
			return "endsWith";
		case "ne":
			return "not";
		case "not_in":
			return "notIn";
		default:
			return operator;
	}
};

const providerSupportsMode = (provider: PrismaProvider) =>
	provider === "postgresql" || provider === "mongodb";

const fieldIsUnique = (
	schema: BetterAuthDBSchema | null | undefined,
	model: string,
	field: string,
): boolean => {
	if (field === "id") return true;
	const fields = schema?.[model]?.fields;
	if (!fields) return false;
	if (fields[field]?.unique) return true;
	for (const [logical, attr] of Object.entries(fields)) {
		if ((attr.fieldName ?? logical) === field && attr.unique) return true;
	}
	return false;
};

const buildSingleCondition = (
	clause: CleanedWhere,
	provider: PrismaProvider,
) => {
	const fieldName = clause.field;
	const mode = clause.mode ?? "sensitive";
	const isInsensitive =
		mode === "insensitive" &&
		(typeof clause.value === "string" ||
			(Array.isArray(clause.value) &&
				clause.value.every((v) => typeof v === "string")));
	const prismaMode =
		isInsensitive && providerSupportsMode(provider) ? "insensitive" : undefined;
	const modeFilter = prismaMode ? { mode: prismaMode } : {};

	if (clause.operator === "ne" && clause.value === null) {
		return { [fieldName]: { not: null } };
	}
	if (
		(clause.operator === "in" || clause.operator === "not_in") &&
		Array.isArray(clause.value)
	) {
		const filtered = clause.value.filter((v) => v != null);
		if (filtered.length === 0) {
			if (clause.operator === "in") {
				return {
					AND: [
						{ [fieldName]: { equals: "__never__" } },
						{ [fieldName]: { not: "__never__" } },
					],
				};
			}
			return {};
		}
		const prismaOp = operatorToPrismaOperator(clause.operator);
		return { [fieldName]: { [prismaOp]: filtered, ...modeFilter } };
	}
	if (clause.operator === "eq") {
		return { [fieldName]: { equals: clause.value, ...modeFilter } };
	}
	if (clause.operator === "ne") {
		return {
			[fieldName]: { not: { equals: clause.value }, ...modeFilter },
		};
	}
	if (
		clause.operator === "contains" ||
		clause.operator === "starts_with" ||
		clause.operator === "ends_with"
	) {
		const prismaOp = operatorToPrismaOperator(clause.operator);
		return { [fieldName]: { [prismaOp]: clause.value, ...modeFilter } };
	}
	const prismaOp = operatorToPrismaOperator(clause.operator);
	return { [fieldName]: { [prismaOp]: clause.value } };
};

export const hasRootUniqueWhereCondition = (
	model: string,
	where: CleanedWhere[] | undefined,
	provider: PrismaProvider,
	schema?: BetterAuthDBSchema | null,
): boolean => {
	if (!where?.length) return false;
	return where.some((condition) => {
		if (condition.connector === "OR") return false;
		if (condition.operator && condition.operator !== "eq") return false;
		if (condition.mode === "insensitive") {
			const isStringValue =
				typeof condition.value === "string" ||
				(Array.isArray(condition.value) &&
					condition.value.every((v) => typeof v === "string"));
			if (providerSupportsMode(provider) && isStringValue) return false;
		}
		return fieldIsUnique(schema, model, condition.field);
	});
};

export type ConvertWhereAction =
	| "create"
	| "update"
	| "delete"
	| "findOne"
	| "findMany"
	| "count"
	| "updateMany"
	| "deleteMany";

export const convertWhereClause = ({
	action,
	where,
	provider,
}: {
	action: ConvertWhereAction;
	where?: CleanedWhere[] | undefined;
	provider: PrismaProvider;
}): Record<string, any> => {
	if (!where?.length) return {};

	if (action === "update") {
		const and = where.filter((w) => w.connector === "AND" || !w.connector);
		const or = where.filter((w) => w.connector === "OR");
		const andSimple = and.filter((w) => w.operator === "eq" || !w.operator);
		const andComplex = and.filter(
			(w) => w.operator !== "eq" && w.operator !== undefined,
		);
		const result: Record<string, any> = {};
		for (const w of andSimple) {
			result[w.field] = w.value;
		}
		const andComplexClause = andComplex.map((w) =>
			buildSingleCondition(w, provider),
		);
		const orClause = or.map((w) => buildSingleCondition(w, provider));
		if (andComplexClause.length) result.AND = andComplexClause;
		if (orClause.length) result.OR = orClause;
		return result;
	}

	if (action === "delete") {
		const idCondition = where.find((w) => w.field === "id");
		if (idCondition) {
			const remainingWhere = where.filter((w) => w.field !== "id");
			if (!remainingWhere.length) {
				return { id: idCondition.value };
			}
			const and = remainingWhere.filter(
				(w) => w.connector === "AND" || !w.connector,
			);
			const or = remainingWhere.filter((w) => w.connector === "OR");
			const result: Record<string, any> = { id: idCondition.value };
			const andClause = and.map((w) => buildSingleCondition(w, provider));
			const orClause = or.map((w) => buildSingleCondition(w, provider));
			if (andClause.length) result.AND = andClause;
			if (orClause.length) result.OR = orClause;
			return result;
		}
	}

	if (where.length === 1) {
		return buildSingleCondition(where[0]!, provider);
	}
	const and = where.filter((w) => w.connector === "AND" || !w.connector);
	const or = where.filter((w) => w.connector === "OR");
	return {
		...(and.length
			? { AND: and.map((w) => buildSingleCondition(w, provider)) }
			: {}),
		...(or.length
			? { OR: or.map((w) => buildSingleCondition(w, provider)) }
			: {}),
	};
};

const withTransaction = async <T>(
	db: PrismaClientLike,
	alreadyInTrx: boolean,
	fn: (tx: PrismaClientLike) => Promise<T>,
): Promise<T> => {
	if (alreadyInTrx || typeof db.$transaction !== "function") {
		return fn(db);
	}
	return db.$transaction(fn);
};

export const storageCreate = v.fn(
	"storage.create",
	{ input: storageCreateInput, ...storeUse },
	async (c) => {
		const db = dbOf(c);
		const delegate = delegateOf(db, c.input.model);
		const result = await delegate.create({
			data: c.input.data,
			select: selectOf(c.input.select),
		});
		return project(result, c.input.select);
	},
);

export const storageFindOne = v.fn(
	"storage.findOne",
	{ input: storageFindOneInput, ...storeUse },
	async (c) => {
		const handle = handleOf(c);
		const db = dbOf(c);
		const delegate = delegateOf(db, c.input.model);
		const result = await delegate.findFirst({
			where: convertWhereClause({
				action: "findOne",
				where: c.input.where,
				provider: handle.provider,
			}),
			select: selectOf(c.input.select),
		});
		return project(result, c.input.select);
	},
);

export const storageFindMany = v.fn(
	"storage.findMany",
	{ input: storageFindManyInput, ...storeUse },
	async (c) => {
		const handle = handleOf(c);
		const db = dbOf(c);
		const delegate = delegateOf(db, c.input.model);
		const rows = (await delegate.findMany({
			where: convertWhereClause({
				action: "findMany",
				where: c.input.where,
				provider: handle.provider,
			}),
			take: c.input.limit,
			skip: c.input.offset ?? 0,
			...(c.input.sortBy
				? {
						orderBy: {
							[c.input.sortBy.field]:
								c.input.sortBy.direction === "desc" ? "desc" : "asc",
						},
					}
				: {}),
			select: selectOf(c.input.select),
		})) as Row[];
		if (!c.input.select?.length) return rows;
		return rows.map((row) => project(row, c.input.select)!);
	},
);

export const storageCount = v.fn(
	"storage.count",
	{ input: storageCountInput, ...storeUse },
	async (c) => {
		const handle = handleOf(c);
		const db = dbOf(c);
		const delegate = delegateOf(db, c.input.model);
		return delegate.count({
			where: convertWhereClause({
				action: "count",
				where: c.input.where,
				provider: handle.provider,
			}),
		});
	},
);

export const storageUpdate = v.fn(
	"storage.update",
	{ input: storageUpdateInput, ...storeUse },
	async (c) => {
		const handle = handleOf(c);
		const db = dbOf(c);
		const delegate = delegateOf(db, c.input.model);
		const schema = c.schema as BetterAuthDBSchema | null;
		const unique = hasRootUniqueWhereCondition(
			c.input.model,
			c.input.where,
			handle.provider,
			schema,
		);
		if (!unique) {
			const whereClause = convertWhereClause({
				action: "updateMany",
				where: c.input.where,
				provider: handle.provider,
			});
			const result = await delegate.updateMany({
				where: whereClause,
				data: c.input.update,
			});
			if (!result?.count) return null;
			return (await delegate.findFirst({ where: whereClause })) as Row | null;
		}
		const whereClause = convertWhereClause({
			action: "update",
			where: c.input.where,
			provider: handle.provider,
		});
		try {
			return (await delegate.update({
				where: whereClause,
				data: c.input.update,
			})) as Row;
		} catch (e) {
			if (isPrismaNotFoundError(e)) return null;
			throw e;
		}
	},
);

export const storageUpdateMany = v.fn(
	"storage.updateMany",
	{ input: storageUpdateInput, ...storeUse },
	async (c) => {
		const handle = handleOf(c);
		const db = dbOf(c);
		const delegate = delegateOf(db, c.input.model);
		const keys = Object.keys(c.input.update);
		if (!keys.length) return 0;
		const result = await delegate.updateMany({
			where: convertWhereClause({
				action: "updateMany",
				where: c.input.where,
				provider: handle.provider,
			}),
			data: c.input.update,
		});
		return result?.count ?? 0;
	},
);

export const storageDelete = v.fn(
	"storage.delete",
	{ input: storageDeleteInput, ...storeUse },
	async (c) => {
		const handle = handleOf(c);
		const db = dbOf(c);
		const delegate = delegateOf(db, c.input.model);
		const hasIdField = c.input.where?.some((w) => w.field === "id");
		if (!hasIdField) {
			await delegate.deleteMany({
				where: convertWhereClause({
					action: "deleteMany",
					where: c.input.where,
					provider: handle.provider,
				}),
			});
			return;
		}
		try {
			await delegate.delete({
				where: convertWhereClause({
					action: "delete",
					where: c.input.where,
					provider: handle.provider,
				}),
			});
		} catch (e) {
			if (isPrismaNotFoundError(e)) return;
			throw e;
		}
	},
);

export const storageDeleteMany = v.fn(
	"storage.deleteMany",
	{ input: storageDeleteInput, ...storeUse },
	async (c) => {
		const handle = handleOf(c);
		const db = dbOf(c);
		const delegate = delegateOf(db, c.input.model);
		const result = await delegate.deleteMany({
			where: convertWhereClause({
				action: "deleteMany",
				where: c.input.where,
				provider: handle.provider,
			}),
		});
		return result?.count ?? 0;
	},
);

export const storageConsumeOne = v.fn(
	"storage.consumeOne",
	{ input: storageDeleteInput, ...storeUse },
	async (c) => {
		const handle = handleOf(c);
		const db = dbOf(c);
		const hasIdField = c.input.where?.some((w) => w.field === "id");
		if (hasIdField) {
			const delegate = delegateOf(db, c.input.model);
			try {
				const row = await delegate.delete({
					where: convertWhereClause({
						action: "delete",
						where: c.input.where,
						provider: handle.provider,
					}),
				});
				return (row as Row) ?? null;
			} catch (e) {
				if (isPrismaNotFoundError(e)) return null;
				throw e;
			}
		}

		const findWhere = convertWhereClause({
			action: "findOne",
			where: c.input.where,
			provider: handle.provider,
		});
		return withTransaction(db, inTransaction(c), async (tx) => {
			const delegate = delegateOf(tx, c.input.model);
			const target = await delegate.findFirst({ where: findWhere });
			if (!target) return null;
			const result = await delegate.deleteMany({
				where: convertWhereClause({
					action: "deleteMany",
					where: [
						...(c.input.where ?? []),
						{
							field: "id",
							value: target.id,
							operator: "eq",
							connector: "AND",
							mode: "sensitive",
						},
					],
					provider: handle.provider,
				}),
			});
			return result?.count > 0 ? (target as Row) : null;
		});
	},
);

export const storageIncrementOne = v.fn(
	"storage.incrementOne",
	{ input: storageIncrementInput, ...storeUse },
	async (c) => {
		const handle = handleOf(c);
		const db = dbOf(c);
		const data: Record<string, unknown> = { ...(c.input.set ?? {}) };
		for (const [field, delta] of Object.entries(c.input.increment)) {
			data[field] = { increment: delta };
		}

		const hasIdField = c.input.where?.some((w) => w.field === "id");
		if (hasIdField) {
			const delegate = delegateOf(db, c.input.model);
			try {
				const row = await delegate.update({
					where: convertWhereClause({
						action: "update",
						where: c.input.where,
						provider: handle.provider,
					}),
					data,
				});
				return (row as Row) ?? null;
			} catch (e) {
				if (isPrismaNotFoundError(e)) return null;
				throw e;
			}
		}

		const findWhere = convertWhereClause({
			action: "findOne",
			where: c.input.where,
			provider: handle.provider,
		});
		return withTransaction(db, inTransaction(c), async (tx) => {
			const delegate = delegateOf(tx, c.input.model);
			const target = await delegate.findFirst({ where: findWhere });
			if (!target) return null;
			try {
				const row = await delegate.update({
					where: convertWhereClause({
						action: "update",
						where: [
							...c.input.where,
							{
								field: "id",
								value: target.id,
								operator: "eq",
								connector: "AND",
								mode: "sensitive",
							},
						],
						provider: handle.provider,
					}),
					data,
				});
				return (row as Row) ?? null;
			} catch (e) {
				if (isPrismaNotFoundError(e)) return null;
				throw e;
			}
		});
	},
);

export const storageApplyDDL = v.fn(
	"storage.applyDDL",
	{ input: storageApplyDDLInput, ...storeUse },
	async (c) => {
		const handle = handleOf(c);
		const db = dbOf(c);
		if (handle.provider !== "sqlite") {
			throw new Error(
				`prisma storage: applyDDL is only implemented for sqlite (got ${handle.provider})`,
			);
		}
		if (typeof db.$executeRawUnsafe !== "function") {
			throw new Error(
				"prisma storage: Prisma client is missing $executeRawUnsafe for DDL",
			);
		}
		for (const statement of c.input.statements) {
			await db.$executeRawUnsafe(statement);
		}
		return { applied: c.input.statements.length, file: c.input.file };
	},
);

/**
 * Begin/commit/rollback mirror the sqlite/drizzle drivers: issue SQL on the
 * shared connection so Prisma queries in the same scope participate. Prisma's
 * callback-style `$transaction` is not used because the public API is
 * begin → run → commit.
 */
export const storageBegin = v.fn(
	"storage.begin",
	{ input: v.object({}), ...storeUse },
	async (c) => {
		if (c.trx != null) {
			throw new Error("nested transactions are not supported");
		}
		const handle = handleOf(c);
		if (handle.provider !== "sqlite") {
			throw new Error(
				`prisma storage: begin is only implemented for sqlite (got ${handle.provider})`,
			);
		}
		if (typeof handle.prisma.$executeRawUnsafe !== "function") {
			throw new Error(
				"prisma storage: Prisma client is missing $executeRawUnsafe for BEGIN",
			);
		}
		await handle.prisma.$executeRawUnsafe("BEGIN");
		c.trx = { prisma: handle.prisma, active: true };
		return { ok: true };
	},
);

export const storageCommit = v.fn(
	"storage.commit",
	{ input: v.object({}), ...storeUse },
	async (c) => {
		const handle = handleOf(c);
		await handle.prisma.$executeRawUnsafe?.("COMMIT");
		c.trx = null;
		return { ok: true };
	},
);

export const storageRollback = v.fn(
	"storage.rollback",
	{ input: v.object({}), ...storeUse },
	async (c) => {
		const handle = handleOf(c);
		try {
			await handle.prisma.$executeRawUnsafe?.("ROLLBACK");
		} catch {
			/* no active transaction */
		}
		c.trx = null;
		return { ok: true };
	},
);

export const prismaStorage = {
	storageCreate,
	storageFindOne,
	storageFindMany,
	storageCount,
	storageUpdate,
	storageUpdateMany,
	storageDelete,
	storageDeleteMany,
	storageConsumeOne,
	storageIncrementOne,
	storageApplyDDL,
	storageBegin,
	storageCommit,
	storageRollback,
};
