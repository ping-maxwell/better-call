import {
	and,
	asc,
	count,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	like,
	lt,
	lte,
	ne,
	notInArray,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
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
import type { CleanedWhere } from "./types";
import { adapterVars } from "./vars";

/**
 * Dialects the driver will grow into. Only `sqlite` is implemented today;
 * `pg` / `mysql` branches should plug into the same client bag.
 */
export type DrizzleProvider = "sqlite" | "pg" | "mysql";

export type DrizzleSchema = Record<string, any>;

/** Handle stored on `c.var.client` for the drizzle storage module. */
export type DrizzleClient = {
	db: any;
	schema: DrizzleSchema;
	provider: DrizzleProvider;
};

type Row = Record<string, any>;

const storeUse = { use: [adapterVars] };

const clientOf = (c: {
	var: { client: { get: () => unknown }; trx: { get: () => unknown } };
}): DrizzleClient => {
	const client = c.var.client.get() as DrizzleClient | null;
	if (!client?.db || !client.schema) {
		throw new Error("drizzle storage: client var is not set");
	}
	return client;
};

/** Prefer the active transaction handle when begin/commit has opened one. */
const dbOf = (c: {
	var: { client: { get: () => unknown }; trx: { get: () => unknown } };
}) => {
	const trx = c.var.trx.get() as { db?: unknown } | null;
	if (trx?.db) return trx.db as any;
	return clientOf(c).db;
};

const tableOf = (client: DrizzleClient, model: string) => {
	const table = client.schema[model];
	if (!table) {
		throw new Error(
			`drizzle storage: model "${model}" was not found in the schema object`,
		);
	}
	return table;
};

const columnOf = (table: any, field: string) => {
	const col = table[field];
	if (!col) {
		throw new Error(
			`drizzle storage: field "${field}" does not exist on the drizzle table`,
		);
	}
	return col;
};

const sqliteClientOf = (db: any) =>
	db?.$client ?? db?.session?.client ?? db?.session?.db ?? null;

/**
 * Normalize write-result row counts across drivers.
 * SQLite/better-sqlite/bun expose `changes`; pg/mysql land later.
 */
export const getAffectedRowCount = (result: unknown): number => {
	if (result && typeof result === "object" && "changes" in result) {
		const n = (result as { changes: unknown }).changes;
		if (typeof n === "number") return n;
	}
	if (result && typeof result === "object" && "rowCount" in result) {
		const n = (result as { rowCount: unknown }).rowCount;
		if (typeof n === "number") return n;
	}
	if (
		result &&
		typeof result === "object" &&
		typeof (result as { count?: unknown }).count === "number"
	) {
		return (result as { count: number }).count;
	}
	if (Array.isArray(result)) {
		const head = result[0];
		if (head && typeof head === "object") {
			if ("affectedRows" in head && typeof head.affectedRows === "number") {
				return head.affectedRows;
			}
			if ("rowsAffected" in head && typeof head.rowsAffected === "number") {
				return head.rowsAffected;
			}
		}
		return result.length;
	}
	if (result && typeof result === "object") {
		if (
			"affectedRows" in result &&
			typeof (result as { affectedRows: unknown }).affectedRows === "number"
		) {
			return (result as { affectedRows: number }).affectedRows;
		}
		if (
			"rowsAffected" in result &&
			typeof (result as { rowsAffected: unknown }).rowsAffected === "number"
		) {
			return (result as { rowsAffected: number }).rowsAffected;
		}
		if ("meta" in result) {
			const meta = (result as { meta: unknown }).meta;
			if (
				meta &&
				typeof meta === "object" &&
				"changes" in meta &&
				typeof (meta as { changes: unknown }).changes === "number"
			) {
				return (meta as { changes: number }).changes;
			}
		}
	}
	return 0;
};

const lower = (col: any) => sql`lower(${col})`;

const clauseFor = (
	table: any,
	clause: CleanedWhere,
	provider: DrizzleProvider,
): SQL => {
	const col = columnOf(table, clause.field);
	const mode = clause.mode ?? "sensitive";
	const isInsensitive =
		mode === "insensitive" &&
		(typeof clause.value === "string" ||
			(Array.isArray(clause.value) &&
				clause.value.every((v) => typeof v === "string")));

	switch (clause.operator) {
		case "in": {
			const values = Array.isArray(clause.value) ? clause.value : [];
			if (!values.length) return sql`0 = 1`;
			if (isInsensitive) {
				return inArray(
					lower(col),
					(values as string[]).map((v) => v.toLowerCase()),
				);
			}
			return inArray(col, values);
		}
		case "not_in": {
			const values = Array.isArray(clause.value) ? clause.value : [];
			if (!values.length) return sql`1 = 1`;
			if (isInsensitive) {
				return notInArray(
					lower(col),
					(values as string[]).map((v) => v.toLowerCase()),
				);
			}
			return notInArray(col, values);
		}
		case "contains": {
			const pattern = `%${clause.value}%`;
			if (isInsensitive && typeof clause.value === "string") {
				// pg can use ilike later; sqlite lowers both sides.
				if (provider === "pg") return sql`${col} ilike ${pattern}`;
				return like(lower(col), `%${String(clause.value).toLowerCase()}%`);
			}
			return like(col, pattern);
		}
		case "starts_with": {
			const pattern = `${clause.value}%`;
			if (isInsensitive && typeof clause.value === "string") {
				if (provider === "pg") return sql`${col} ilike ${pattern}`;
				return like(lower(col), `${String(clause.value).toLowerCase()}%`);
			}
			return like(col, pattern);
		}
		case "ends_with": {
			const pattern = `%${clause.value}`;
			if (isInsensitive && typeof clause.value === "string") {
				if (provider === "pg") return sql`${col} ilike ${pattern}`;
				return like(lower(col), `%${String(clause.value).toLowerCase()}`);
			}
			return like(col, pattern);
		}
		case "lt":
			return lt(col, clause.value);
		case "lte":
			return lte(col, clause.value);
		case "gt":
			return gt(col, clause.value);
		case "gte":
			return gte(col, clause.value);
		case "ne":
			if (clause.value === null) return isNotNull(col);
			if (isInsensitive && typeof clause.value === "string") {
				return ne(lower(col), clause.value.toLowerCase());
			}
			return ne(col, clause.value);
		default:
			if (clause.value === null) return isNull(col);
			if (isInsensitive && typeof clause.value === "string") {
				return eq(lower(col), clause.value.toLowerCase());
			}
			return eq(col, clause.value);
	}
};

export const buildWhere = (
	table: any,
	where: CleanedWhere[] | undefined,
	provider: DrizzleProvider,
): SQL | undefined => {
	if (!where?.length) return undefined;
	const andParts: SQL[] = [];
	const orParts: SQL[] = [];
	for (const clause of where) {
		const frag = clauseFor(table, clause, provider);
		if (clause.connector === "OR") orParts.push(frag);
		else andParts.push(frag);
	}
	if (andParts.length && orParts.length) {
		return and(and(...andParts)!, or(...orParts)!)!;
	}
	if (andParts.length === 1) return andParts[0];
	if (andParts.length > 1) return and(...andParts)!;
	if (orParts.length === 1) return orParts[0];
	if (orParts.length > 1) return or(...orParts)!;
	return undefined;
};

const project = (row: Row | null | undefined, select?: string[]) => {
	if (!row) return null;
	if (!select?.length) return row;
	const out: Row = {};
	if ("id" in row) out.id = row.id;
	for (const s of select) out[s] = row[s];
	return out;
};

const selectColumns = (table: any, select?: string[]) => {
	if (!select?.length) return undefined;
	const cols: Record<string, any> = {};
	if (table.id) cols.id = table.id;
	for (const s of select) {
		if (table[s]) cols[s] = table[s];
	}
	return cols;
};

export const storageCreate = v.fn(
	"storage.create",
	{ input: storageCreateInput, ...storeUse },
	async (c) => {
		const client = clientOf(c);
		const db = dbOf(c);
		const table = tableOf(client, c.input.model);
		const data = c.input.data;
		const inserted = await db.insert(table).values(data).returning();
		return project(inserted[0] ?? data, c.input.select);
	},
);

export const storageFindOne = v.fn(
	"storage.findOne",
	{ input: storageFindOneInput, ...storeUse },
	async (c) => {
		const client = clientOf(c);
		const db = dbOf(c);
		const table = tableOf(client, c.input.model);
		const where = buildWhere(table, c.input.where, client.provider);
		const cols = selectColumns(table, c.input.select);
		let query = db.select(cols).from(table);
		if (where) query = query.where(where);
		const rows = await query.limit(1);
		return project(rows[0] ?? null, c.input.select);
	},
);

export const storageFindMany = v.fn(
	"storage.findMany",
	{ input: storageFindManyInput, ...storeUse },
	async (c) => {
		const client = clientOf(c);
		const db = dbOf(c);
		const table = tableOf(client, c.input.model);
		const where = buildWhere(table, c.input.where, client.provider);
		const cols = selectColumns(table, c.input.select);
		let query = db.select(cols).from(table);
		if (where) query = query.where(where);
		if (c.input.sortBy) {
			const col = columnOf(table, c.input.sortBy.field);
			query = query.orderBy(
				c.input.sortBy.direction === "desc" ? desc(col) : asc(col),
			);
		}
		query = query.limit(c.input.limit);
		if (c.input.offset) query = query.offset(c.input.offset);
		const rows = (await query) as Row[];
		if (!c.input.select?.length) return rows;
		return rows.map((row) => project(row, c.input.select)!);
	},
);

export const storageCount = v.fn(
	"storage.count",
	{ input: storageCountInput, ...storeUse },
	async (c) => {
		const client = clientOf(c);
		const db = dbOf(c);
		const table = tableOf(client, c.input.model);
		const where = buildWhere(table, c.input.where, client.provider);
		let query = db.select({ count: count() }).from(table);
		if (where) query = query.where(where);
		const rows = await query;
		return Number(rows[0]?.count ?? 0);
	},
);

export const storageUpdate = v.fn(
	"storage.update",
	{ input: storageUpdateInput, ...storeUse },
	async (c) => {
		const client = clientOf(c);
		const db = dbOf(c);
		const table = tableOf(client, c.input.model);
		const where = buildWhere(table, c.input.where, client.provider);
		const keys = Object.keys(c.input.update);
		if (!keys.length) {
			let query = db.select().from(table);
			if (where) query = query.where(where);
			const rows = await query.limit(1);
			return (rows[0] as Row | undefined) ?? null;
		}
		let builder = db.update(table).set(c.input.update);
		if (where) builder = builder.where(where);
		if (client.provider === "mysql") {
			await builder;
			let query = db.select().from(table);
			if (where) query = query.where(where);
			const rows = await query.limit(1);
			return (rows[0] as Row | undefined) ?? null;
		}
		const updated = await builder.returning();
		return (updated[0] as Row | undefined) ?? null;
	},
);

export const storageUpdateMany = v.fn(
	"storage.updateMany",
	{ input: storageUpdateInput, ...storeUse },
	async (c) => {
		const client = clientOf(c);
		const db = dbOf(c);
		const table = tableOf(client, c.input.model);
		const keys = Object.keys(c.input.update);
		if (!keys.length) return 0;
		const where = buildWhere(table, c.input.where, client.provider);
		let builder = db.update(table).set(c.input.update);
		if (where) builder = builder.where(where);
		const result = await builder;
		return getAffectedRowCount(result);
	},
);

export const storageDelete = v.fn(
	"storage.delete",
	{ input: storageDeleteInput, ...storeUse },
	async (c) => {
		const client = clientOf(c);
		const db = dbOf(c);
		const table = tableOf(client, c.input.model);
		const where = buildWhere(table, c.input.where, client.provider);
		let builder = db.delete(table);
		if (where) builder = builder.where(where);
		// Single-row delete: SQLite supports LIMIT on DELETE.
		if (client.provider === "sqlite") {
			await builder.limit(1);
			return;
		}
		const idCol = table.id;
		if (idCol && where) {
			const targetIds = db
				.select({ id: idCol })
				.from(table)
				.where(where)
				.limit(1);
			await db.delete(table).where(inArray(idCol, targetIds));
			return;
		}
		await builder;
	},
);

export const storageDeleteMany = v.fn(
	"storage.deleteMany",
	{ input: storageDeleteInput, ...storeUse },
	async (c) => {
		const client = clientOf(c);
		const db = dbOf(c);
		const table = tableOf(client, c.input.model);
		const where = buildWhere(table, c.input.where, client.provider);
		let builder = db.delete(table);
		if (where) builder = builder.where(where);
		const result = await builder;
		return getAffectedRowCount(result);
	},
);

export const storageConsumeOne = v.fn(
	"storage.consumeOne",
	{ input: storageDeleteInput, ...storeUse },
	async (c) => {
		const client = clientOf(c);
		const db = dbOf(c);
		const table = tableOf(client, c.input.model);
		const where = buildWhere(table, c.input.where, client.provider);
		const idCol = table.id;
		if (!idCol) return null;

		if (client.provider === "mysql") {
			// MySQL has no DELETE … RETURNING; select then delete by id.
			let select = db.select().from(table);
			if (where) select = select.where(where);
			const rows = await select.limit(1);
			const target = rows[0] as Row | undefined;
			if (!target?.id) return null;
			await db.delete(table).where(eq(idCol, target.id));
			return target;
		}

		const targetIds = db
			.select({ id: idCol })
			.from(table)
			.where(where ?? sql`1 = 1`)
			.limit(1);
		const deleted = await db
			.delete(table)
			.where(inArray(idCol, targetIds))
			.returning();
		return (deleted[0] as Row | undefined) ?? null;
	},
);

export const storageIncrementOne = v.fn(
	"storage.incrementOne",
	{ input: storageIncrementInput, ...storeUse },
	async (c) => {
		const client = clientOf(c);
		const db = dbOf(c);
		const table = tableOf(client, c.input.model);
		const where = buildWhere(table, c.input.where, client.provider);
		const idCol = table.id;
		if (!idCol) return null;

		const assignments: Record<string, unknown> = { ...(c.input.set ?? {}) };
		for (const [field, delta] of Object.entries(c.input.increment)) {
			const col = columnOf(table, field);
			assignments[field] = sql`${col} + ${delta}`;
		}

		const targetIds = db
			.select({ id: idCol })
			.from(table)
			.where(where ?? sql`1 = 1`)
			.limit(1);

		if (client.provider === "mysql") {
			let select = db.select().from(table);
			if (where) select = select.where(where);
			const rows = await select.limit(1);
			const target = rows[0] as Row | undefined;
			if (!target?.id) return null;
			await db.update(table).set(assignments).where(eq(idCol, target.id));
			const updated = await db
				.select()
				.from(table)
				.where(eq(idCol, target.id))
				.limit(1);
			return (updated[0] as Row | undefined) ?? null;
		}

		const updated = await db
			.update(table)
			.set(assignments)
			.where(inArray(idCol, targetIds))
			.returning();
		return (updated[0] as Row | undefined) ?? null;
	},
);

export const storageApplyDDL = v.fn(
	"storage.applyDDL",
	{ input: storageApplyDDLInput, ...storeUse },
	async (c) => {
		const client = clientOf(c);
		const db = dbOf(c);
		if (client.provider !== "sqlite") {
			throw new Error(
				`drizzle storage: applyDDL is only implemented for sqlite (got ${client.provider})`,
			);
		}
		const raw = sqliteClientOf(db);
		if (!raw || typeof raw.run !== "function") {
			throw new Error(
				"drizzle storage: could not reach the underlying sqlite client for DDL",
			);
		}
		for (const statement of c.input.statements) {
			raw.run(statement);
		}
		return { applied: c.input.statements.length, file: c.input.file };
	},
);

/**
 * Begin/commit/rollback mirror the sqlite driver: issue SQL on the shared
 * connection so drizzle queries in the same scope participate. Drizzle's
 * callback-style `db.transaction` is not used because the public API is
 * begin → run → commit.
 */
export const storageBegin = v.fn(
	"storage.begin",
	{ input: v.object({}), ...storeUse },
	(c) => {
		if (c.var.trx.get() != null) {
			throw new Error("nested transactions are not supported");
		}
		const client = clientOf(c);
		if (client.provider !== "sqlite") {
			throw new Error(
				`drizzle storage: begin is only implemented for sqlite (got ${client.provider})`,
			);
		}
		const raw = sqliteClientOf(client.db);
		if (!raw || typeof raw.run !== "function") {
			throw new Error(
				"drizzle storage: could not reach the underlying sqlite client for BEGIN",
			);
		}
		raw.run("BEGIN");
		c.var.trx.set({ db: client.db, active: true });
		return { ok: true };
	},
);

export const storageCommit = v.fn(
	"storage.commit",
	{ input: v.object({}), ...storeUse },
	(c) => {
		const client = clientOf(c);
		const raw = sqliteClientOf(client.db);
		raw?.run?.("COMMIT");
		c.var.trx.set(null);
		return { ok: true };
	},
);

export const storageRollback = v.fn(
	"storage.rollback",
	{ input: v.object({}), ...storeUse },
	(c) => {
		const client = clientOf(c);
		try {
			sqliteClientOf(client.db)?.run?.("ROLLBACK");
		} catch {
			/* no active transaction */
		}
		c.var.trx.set(null);
		return { ok: true };
	},
);

export const drizzleStorage = {
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
