import { PgColumn, bigint, boolean, char, index, integer, jsonb, numeric, pgSchema, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const tenantsColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	subdomain: varchar('subdomain', { length: 100 }).notNull().unique(),
	schemaName: varchar('schema_name', { length: 100 }).notNull().unique(),
	companyId: uuid('company_id').notNull(),
	companyName: varchar('company_name', { length: 255 }),
	godAdminEmail: varchar('god_admin_email', { length: 255 }).notNull(),
	status: varchar('status', { length: 20 }).notNull().default('provisioning'),
	plan: varchar('plan', { length: 50 }).default('free'),
	domain: varchar('domain', { length: 255 }),
	settings: jsonb('settings').default(sql`'{}'`),
	trustedSources: jsonb('trusted_sources').default(sql`'[]'`),
	maxUsers: integer('max_users'),
	provisionedAt: timestamp('provisioned_at', { withTimezone: true }),
	suspendedAt: timestamp('suspended_at', { withTimezone: true }),
	suspendedReason: text('suspended_reason'),
};

export const tenantsIndexes = (t: { status: PgColumn }) => [
	index('tenants_status_idx').on(t.status),
];

export const tenants = pgTable('tenants', tenantsColumns, (t) => [
	index('tenants_status_idx').on(t.status),
]);

export function createTenantsForSchema(schema: ReturnType<typeof pgSchema>) {
	return schema.table('tenants', tenantsColumns, (t) => [
		index('tenants_status_idx').on(t.status),
	]);
}

export const tenantEventsColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
	eventType: varchar('event_type', { length: 50 }).notNull(),
	eventData: jsonb('event_data').default(sql`'{}'`),
	performedBy: varchar('performed_by', { length: 255 }),
	ipAddress: varchar('ip_address', { length: 45 }),
};

export const tenantEventsIndexes = (t: { tenantId: PgColumn; eventType: PgColumn }) => [
	index('tenant_events_tenant_id_idx').on(t.tenantId),
	index('tenant_events_event_type_idx').on(t.eventType),
];

export const tenantEvents = pgTable('tenant_events', tenantEventsColumns, (t) => [
	index('tenant_events_tenant_id_idx').on(t.tenantId),
	index('tenant_events_event_type_idx').on(t.eventType),
]);

export function createTenantEventsForSchema(schema: ReturnType<typeof pgSchema>) {
	const tenantsTable = schema.table('tenants', tenantsColumns, (t) => tenantsIndexes(t));
	return schema.table('tenant_events', {
		...tenantEventsColumns,
		tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'cascade' }),
	}, (t) => [
		index('tenant_events_tenant_id_idx').on(t.tenantId),
		index('tenant_events_event_type_idx').on(t.eventType),
	]);
}

export const tenantFeaturesColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
	featureName: varchar('feature_name', { length: 100 }).notNull(),
	enabled: boolean('enabled').notNull().default(true),
	config: jsonb('config').default(sql`'{}'`),
};

export const tenantFeaturesIndexes = (t: { tenantId: PgColumn; featureName: PgColumn }) => [
	uniqueIndex('tenant_features_tenant_id_feature_name_idx').on(t.tenantId, t.featureName),
	index('tenant_features_feature_name_idx').on(t.featureName),
];

export const tenantFeatures = pgTable('tenant_features', tenantFeaturesColumns, (t) => [
	uniqueIndex('tenant_features_tenant_id_feature_name_idx').on(t.tenantId, t.featureName),
	index('tenant_features_feature_name_idx').on(t.featureName),
]);

export function createTenantFeaturesForSchema(schema: ReturnType<typeof pgSchema>) {
	const tenantsTable = schema.table('tenants', tenantsColumns, (t) => tenantsIndexes(t));
	return schema.table('tenant_features', {
		...tenantFeaturesColumns,
		tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'cascade' }),
	}, (t) => [
		uniqueIndex('tenant_features_tenant_id_feature_name_idx').on(t.tenantId, t.featureName),
		index('tenant_features_feature_name_idx').on(t.featureName),
	]);
}

export const datasetDefinitionsColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	name: varchar('name', { length: 200 }).notNull(),
	sourceSchema: varchar('source_schema', { length: 63 }).notNull(),
	sourceTable: varchar('source_table', { length: 63 }).notNull(),
	targetColumn: varchar('target_column', { length: 63 }).notNull(),
	timeColumn: varchar('time_column', { length: 63 }),
};

export const datasetDefinitions = pgTable('dataset_definitions', datasetDefinitionsColumns);

export function createDatasetDefinitionsForSchema(schema: ReturnType<typeof pgSchema>) {
	return schema.table('dataset_definitions', datasetDefinitionsColumns);
}

export const datasetColumnsColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	datasetDefinitionId: uuid('dataset_definition_id').notNull().references(() => datasetDefinitions.id, { onDelete: 'cascade' }),
	columnName: varchar('column_name', { length: 255 }).notNull(),
	role: varchar('role', { length: 16 }).notNull(),
	dataType: varchar('data_type', { length: 16 }).notNull(),
	description: text('description').notNull(),
	unit: varchar('unit', { length: 100 }),
	isNullable: boolean('is_nullable').notNull(),
	position: integer('position').notNull(),
};

export const datasetColumnsIndexes = (t: { datasetDefinitionId: PgColumn; columnName: PgColumn }) => [
	uniqueIndex('uq_dataset_columns_definition_name').on(t.datasetDefinitionId, t.columnName),
];

export const datasetColumns = pgTable('dataset_columns', datasetColumnsColumns, (t) => [
	uniqueIndex('uq_dataset_columns_definition_name').on(t.datasetDefinitionId, t.columnName),
]);

export function createDatasetColumnsForSchema(schema: ReturnType<typeof pgSchema>) {
	const datasetDefinitionsTable = schema.table('dataset_definitions', datasetDefinitionsColumns);
	return schema.table('dataset_columns', {
		...datasetColumnsColumns,
		datasetDefinitionId: uuid('dataset_definition_id').notNull().references(() => datasetDefinitionsTable.id, { onDelete: 'cascade' }),
	}, (t) => [
		uniqueIndex('uq_dataset_columns_definition_name').on(t.datasetDefinitionId, t.columnName),
	]);
}

export const datasetSnapshotsColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	datasetDefinitionId: uuid('dataset_definition_id').notNull().references(() => datasetDefinitions.id, { onDelete: 'cascade' }),
	storageUri: text('storage_uri').notNull(),
	storageFormat: varchar('storage_format', { length: 16 }).notNull(),
	contentSha256: char('content_sha256', { length: 64 }).notNull().unique(),
	rowCount: bigint('row_count', { mode: 'number' }).notNull(),
	schemaSummary: jsonb('schema_summary').notNull(),
	frozenAt: timestamp('frozen_at', { withTimezone: true }).notNull(),
};

export const datasetSnapshots = pgTable('dataset_snapshots', datasetSnapshotsColumns);

export function createDatasetSnapshotsForSchema(schema: ReturnType<typeof pgSchema>) {
	const datasetDefinitionsTable = schema.table('dataset_definitions', datasetDefinitionsColumns);
	return schema.table('dataset_snapshots', {
		...datasetSnapshotsColumns,
		datasetDefinitionId: uuid('dataset_definition_id').notNull().references(() => datasetDefinitionsTable.id, { onDelete: 'cascade' }),
	});
}

export const trainingJobsColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	datasetSnapshotId: uuid('dataset_snapshot_id').notNull().references(() => datasetSnapshots.id, { onDelete: 'restrict' }),
	fingerprint: char('fingerprint', { length: 64 }).notNull().unique(),
	status: varchar('status', { length: 16 }).notNull(),
	trainingConfig: jsonb('training_config').notNull(),
	progressPercent: integer('progress_percent').notNull(),
	progressMessage: text('progress_message'),
	claimedBy: varchar('claimed_by', { length: 255 }),
	queuedAt: timestamp('queued_at', { withTimezone: true }).notNull(),
	startedAt: timestamp('started_at', { withTimezone: true }),
	heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
	finishedAt: timestamp('finished_at', { withTimezone: true }),
	errorCode: varchar('error_code', { length: 100 }),
	errorMessage: text('error_message'),
	maxRuntimeSeconds: integer('max_runtime_seconds').notNull(),
};

export const trainingJobs = pgTable('training_jobs', trainingJobsColumns);

export function createTrainingJobsForSchema(schema: ReturnType<typeof pgSchema>) {
	const datasetSnapshotsTable = schema.table('dataset_snapshots', datasetSnapshotsColumns);
	return schema.table('training_jobs', {
		...trainingJobsColumns,
		datasetSnapshotId: uuid('dataset_snapshot_id').notNull().references(() => datasetSnapshotsTable.id, { onDelete: 'restrict' }),
	});
}

export const modelVersionsColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	datasetDefinitionId: uuid('dataset_definition_id').notNull().references(() => datasetDefinitions.id, { onDelete: 'restrict' }),
	trainingJobId: uuid('training_job_id').notNull().unique().references(() => trainingJobs.id, { onDelete: 'restrict' }),
	versionNumber: integer('version_number').notNull(),
	status: varchar('status', { length: 16 }).notNull(),
	parentVersionId: uuid('parent_version_id'),
	metrics: jsonb('metrics').notNull(),
	baselineMetrics: jsonb('baseline_metrics').notNull(),
	publishedAt: timestamp('published_at', { withTimezone: true }),
	publishedBy: uuid('published_by'),
};

export const modelVersions = pgTable('model_versions', modelVersionsColumns);

export function createModelVersionsForSchema(schema: ReturnType<typeof pgSchema>) {
	const datasetDefinitionsTable = schema.table('dataset_definitions', datasetDefinitionsColumns);
	const trainingJobsTable = schema.table('training_jobs', trainingJobsColumns);
	return schema.table('model_versions', {
		...modelVersionsColumns,
		datasetDefinitionId: uuid('dataset_definition_id').notNull().references(() => datasetDefinitionsTable.id, { onDelete: 'restrict' }),
		trainingJobId: uuid('training_job_id').notNull().references(() => trainingJobsTable.id, { onDelete: 'restrict' }),
		parentVersionId: uuid('parent_version_id'),
	});
}

export const modelArtifactsColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	modelVersionId: uuid('model_version_id').notNull().unique().references(() => modelVersions.id, { onDelete: 'restrict' }),
	storageUri: text('storage_uri').notNull(),
	format: varchar('format', { length: 16 }).notNull(),
	contentSha256: char('content_sha256', { length: 64 }).notNull().unique(),
	sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
	producerWorkerId: varchar('producer_worker_id', { length: 255 }).notNull(),
	producedAt: timestamp('produced_at', { withTimezone: true }).notNull(),
};

export const modelArtifacts = pgTable('model_artifacts', modelArtifactsColumns);

export function createModelArtifactsForSchema(schema: ReturnType<typeof pgSchema>) {
	const modelVersionsTable = schema.table('model_versions', modelVersionsColumns);
	return schema.table('model_artifacts', {
		...modelArtifactsColumns,
		modelVersionId: uuid('model_version_id').notNull().references(() => modelVersionsTable.id, { onDelete: 'restrict' }),
	});
}

export const modelFeaturesColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	modelVersionId: uuid('model_version_id').notNull().references(() => modelVersions.id, { onDelete: 'cascade' }),
	columnName: varchar('column_name', { length: 255 }).notNull(),
	position: integer('position').notNull(),
	dataType: varchar('data_type', { length: 16 }).notNull(),
	description: text('description').notNull(),
	unit: varchar('unit', { length: 100 }),
	isRequired: boolean('is_required').notNull(),
	validMin: numeric('valid_min'),
	validMax: numeric('valid_max'),
	allowedValues: jsonb('allowed_values'),
	missingRate: numeric('missing_rate').notNull(),
};

export const modelFeatures = pgTable('model_features', modelFeaturesColumns);

export function createModelFeaturesForSchema(schema: ReturnType<typeof pgSchema>) {
	const modelVersionsTable = schema.table('model_versions', modelVersionsColumns);
	return schema.table('model_features', {
		...modelFeaturesColumns,
		modelVersionId: uuid('model_version_id').notNull().references(() => modelVersionsTable.id, { onDelete: 'cascade' }),
	});
}

export const toolDefinitionsColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	modelVersionId: uuid('model_version_id').notNull().unique().references(() => modelVersions.id, { onDelete: 'restrict' }),
	toolName: varchar('tool_name', { length: 255 }).notNull().unique(),
	description: text('description').notNull(),
	inputSchema: jsonb('input_schema').notNull(),
	outputSchema: jsonb('output_schema').notNull(),
	generatorVersion: varchar('generator_version', { length: 50 }).notNull(),
	schemaSha256: char('schema_sha256', { length: 64 }).notNull().unique(),
	generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
};

export const toolDefinitions = pgTable('tool_definitions', toolDefinitionsColumns);

export function createToolDefinitionsForSchema(schema: ReturnType<typeof pgSchema>) {
	const modelVersionsTable = schema.table('model_versions', modelVersionsColumns);
	return schema.table('tool_definitions', {
		...toolDefinitionsColumns,
		modelVersionId: uuid('model_version_id').notNull().references(() => modelVersionsTable.id, { onDelete: 'restrict' }),
	});
}

export const inferenceCallsColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	toolDefinitionId: uuid('tool_definition_id').notNull().references(() => toolDefinitions.id, { onDelete: 'restrict' }),
	modelVersionId: uuid('model_version_id').notNull().references(() => modelVersions.id, { onDelete: 'restrict' }),
	conversationId: varchar('conversation_id', { length: 255 }),
	inputPayload: jsonb('input_payload').notNull(),
	outcome: varchar('outcome', { length: 16 }).notNull(),
	prediction: numeric('prediction'),
	uncertainty: numeric('uncertainty'),
	warnings: jsonb('warnings').notNull(),
	rejectionCode: varchar('rejection_code', { length: 100 }),
	rejectionMessage: text('rejection_message'),
	latencyMs: integer('latency_ms').notNull(),
};

export const inferenceCalls = pgTable('inference_calls', inferenceCallsColumns);

export function createInferenceCallsForSchema(schema: ReturnType<typeof pgSchema>) {
	const toolDefinitionsTable = schema.table('tool_definitions', toolDefinitionsColumns);
	const modelVersionsTable = schema.table('model_versions', modelVersionsColumns);
	return schema.table('inference_calls', {
		...inferenceCallsColumns,
		toolDefinitionId: uuid('tool_definition_id').notNull().references(() => toolDefinitionsTable.id, { onDelete: 'restrict' }),
		modelVersionId: uuid('model_version_id').notNull().references(() => modelVersionsTable.id, { onDelete: 'restrict' }),
	});
}

export function createAllTablesForSchema(schema: ReturnType<typeof pgSchema>) {
	const tables: Record<string, unknown> = {};

	tables.tenants = createTenantsForSchema(schema);
	tables.tenantEvents = createTenantEventsForSchema(schema);
	tables.tenantFeatures = createTenantFeaturesForSchema(schema);
	tables.datasetDefinitions = createDatasetDefinitionsForSchema(schema);
	tables.datasetColumns = createDatasetColumnsForSchema(schema);
	tables.datasetSnapshots = createDatasetSnapshotsForSchema(schema);
	tables.trainingJobs = createTrainingJobsForSchema(schema);
	tables.modelVersions = createModelVersionsForSchema(schema);
	tables.modelArtifacts = createModelArtifactsForSchema(schema);
	tables.modelFeatures = createModelFeaturesForSchema(schema);
	tables.toolDefinitions = createToolDefinitionsForSchema(schema);
	tables.inferenceCalls = createInferenceCallsForSchema(schema);

	return tables;
}
