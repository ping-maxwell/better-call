import type { Database } from "bun:sqlite";
import type { PrismaClientLike } from "./prisma";

type Row = Record<string, any>;

type PrismaFilter = Record<string, any>;

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

const notFound = (cause: string) => {
	const err = new Error(cause) as Error & {
		code: string;
		meta: { cause: string };
	};
	err.code = "P2025";
	err.meta = { cause };
	return err;
};

const matchFilter = (row: Row, filter: PrismaFilter | undefined): boolean => {
	if (!filter || !Object.keys(filter).length) return true;
	if (filter.AND) {
		const parts = Array.isArray(filter.AND) ? filter.AND : [filter.AND];
		if (!parts.every((p) => matchFilter(row, p))) return false;
	}
	if (filter.OR) {
		const parts = Array.isArray(filter.OR) ? filter.OR : [filter.OR];
		if (!parts.some((p) => matchFilter(row, p))) return false;
	}
	for (const [key, raw] of Object.entries(filter)) {
		if (key === "AND" || key === "OR") continue;
		const value = row[key];
		if (raw === null) {
			if (value != null) return false;
			continue;
		}
		if (typeof raw !== "object" || raw instanceof Date) {
			if (value !== raw) return false;
			continue;
		}
		const ops = raw as Record<string, any>;
		if ("equals" in ops) {
			const mode = ops.mode;
			if (mode === "insensitive" && typeof ops.equals === "string") {
				if (String(value).toLowerCase() !== ops.equals.toLowerCase()) {
					return false;
				}
			} else if (value !== ops.equals) {
				return false;
			}
		}
		if ("not" in ops) {
			const notVal = ops.not;
			if (notVal === null) {
				if (value == null) return false;
			} else if (typeof notVal === "object" && notVal && "equals" in notVal) {
				if (value === notVal.equals) return false;
			} else if (value === notVal) {
				return false;
			}
		}
		if ("in" in ops) {
			const list = Array.isArray(ops.in) ? ops.in : [];
			if (!list.includes(value)) return false;
		}
		if ("notIn" in ops) {
			const list = Array.isArray(ops.notIn) ? ops.notIn : [];
			if (list.includes(value)) return false;
		}
		if ("lt" in ops && !(value < ops.lt)) return false;
		if ("lte" in ops && !(value <= ops.lte)) return false;
		if ("gt" in ops && !(value > ops.gt)) return false;
		if ("gte" in ops && !(value >= ops.gte)) return false;
		if ("contains" in ops) {
			const hay =
				ops.mode === "insensitive"
					? String(value).toLowerCase()
					: String(value);
			const needle =
				ops.mode === "insensitive"
					? String(ops.contains).toLowerCase()
					: String(ops.contains);
			if (!hay.includes(needle)) return false;
		}
		if ("startsWith" in ops) {
			const hay =
				ops.mode === "insensitive"
					? String(value).toLowerCase()
					: String(value);
			const needle =
				ops.mode === "insensitive"
					? String(ops.startsWith).toLowerCase()
					: String(ops.startsWith);
			if (!hay.startsWith(needle)) return false;
		}
		if ("endsWith" in ops) {
			const hay =
				ops.mode === "insensitive"
					? String(value).toLowerCase()
					: String(value);
			const needle =
				ops.mode === "insensitive"
					? String(ops.endsWith).toLowerCase()
					: String(ops.endsWith);
			if (!hay.endsWith(needle)) return false;
		}
	}
	return true;
};

const applySelect = (row: Row, select?: Record<string, boolean>) => {
	if (!select) return { ...row };
	const out: Row = {};
	for (const [key, on] of Object.entries(select)) {
		if (on) out[key] = row[key];
	}
	return out;
};

const applyData = (row: Row, data: Record<string, any>) => {
	const next = { ...row };
	for (const [key, value] of Object.entries(data)) {
		if (
			value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			!(value instanceof Date) &&
			"increment" in value
		) {
			next[key] = Number(next[key] ?? 0) + Number(value.increment);
		} else {
			next[key] = value;
		}
	}
	return next;
};

const createDelegate = (db: Database, model: string) => {
	const table = quoteIdent(model);
	const all = (): Row[] => db.query(`SELECT * FROM ${table}`).all() as Row[];

	const write = (rows: Row[]) => {
		db.run(`DELETE FROM ${table}`);
		for (const row of rows) {
			const keys = Object.keys(row);
			if (!keys.length) continue;
			const cols = keys.map(quoteIdent).join(", ");
			const placeholders = keys.map(() => "?").join(", ");
			db.run(
				`INSERT INTO ${table} (${cols}) VALUES (${placeholders})`,
				keys.map((k) => row[k] as any),
			);
		}
	};

	return {
		async create({
			data,
			select,
		}: {
			data: Row;
			select?: Record<string, boolean>;
		}) {
			const rows = all();
			rows.push({ ...data });
			write(rows);
			return applySelect(data, select);
		},
		async findFirst({
			where,
			select,
		}: {
			where?: PrismaFilter;
			select?: Record<string, boolean>;
		}) {
			const row = all().find((r) => matchFilter(r, where));
			return row ? applySelect(row, select) : null;
		},
		async findMany({
			where,
			take,
			skip,
			orderBy,
			select,
		}: {
			where?: PrismaFilter;
			take?: number;
			skip?: number;
			orderBy?: Record<string, "asc" | "desc">;
			select?: Record<string, boolean>;
		}) {
			let rows = all().filter((r) => matchFilter(r, where));
			if (orderBy) {
				const [field, direction] = Object.entries(orderBy)[0] ?? [];
				if (field) {
					rows = [...rows].sort((a, b) => {
						const av = a[field];
						const bv = b[field];
						if (av === bv) return 0;
						const cmp = av > bv ? 1 : -1;
						return direction === "desc" ? -cmp : cmp;
					});
				}
			}
			const start = skip ?? 0;
			const end = take == null ? undefined : start + take;
			return rows.slice(start, end).map((r) => applySelect(r, select));
		},
		async count({ where }: { where?: PrismaFilter }) {
			return all().filter((r) => matchFilter(r, where)).length;
		},
		async update({
			where,
			data,
		}: {
			where: PrismaFilter;
			data: Record<string, any>;
		}) {
			const rows = all();
			const idx = rows.findIndex((r) => matchFilter(r, where));
			if (idx < 0) {
				throw notFound("Record to update not found.");
			}
			rows[idx] = applyData(rows[idx]!, data);
			write(rows);
			return { ...rows[idx]! };
		},
		async updateMany({
			where,
			data,
		}: {
			where?: PrismaFilter;
			data: Record<string, any>;
		}) {
			const rows = all();
			let count = 0;
			for (let i = 0; i < rows.length; i++) {
				if (!matchFilter(rows[i]!, where)) continue;
				rows[i] = applyData(rows[i]!, data);
				count++;
			}
			if (count) write(rows);
			return { count };
		},
		async delete({ where }: { where: PrismaFilter }) {
			const rows = all();
			const idx = rows.findIndex((r) => matchFilter(r, where));
			if (idx < 0) {
				throw notFound("Record to delete does not exist.");
			}
			const [removed] = rows.splice(idx, 1);
			write(rows);
			return { ...removed! };
		},
		async deleteMany({ where }: { where?: PrismaFilter }) {
			const rows = all();
			const kept: Row[] = [];
			let count = 0;
			for (const row of rows) {
				if (matchFilter(row, where)) count++;
				else kept.push(row);
			}
			if (count) write(kept);
			return { count };
		},
	};
};

/**
 * Minimal Prisma-shaped client over bun:sqlite for adapter contract tests.
 * Not a full Prisma Client — only the delegate surface the storage module uses.
 */
export const createTestPrismaClient = (
	db: Database,
	models: string[] = ["user", "token", "session"],
): PrismaClientLike => {
	const client: PrismaClientLike = {
		async $executeRawUnsafe(sql: string) {
			db.run(sql);
			return 0;
		},
		async $transaction(fn) {
			db.run("BEGIN");
			try {
				const result = await fn(client);
				db.run("COMMIT");
				return result;
			} catch (err) {
				try {
					db.run("ROLLBACK");
				} catch {
					/* ignore */
				}
				throw err;
			}
		},
	};
	for (const model of models) {
		client[model] = createDelegate(db, model);
	}
	return client;
};
