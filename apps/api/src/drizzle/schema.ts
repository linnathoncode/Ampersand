import { PgColumn, bigint, boolean, char, index, integer, jsonb, numeric, pgSchema, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const usersColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	email: varchar('email', { length: 255 }),
	password: varchar('password', { length: 255 }),
	verifiedAt: timestamp('verified_at'),
	emailVerificationToken: varchar('email_verification_token', { length: 255 }),
	emailVerificationTokenExpiresAt: timestamp('email_verification_token_expires_at'),
	emailVerificationSentAt: timestamp('email_verification_sent_at'),
	emailVerificationAttempts: integer('email_verification_attempts').default(0),
	lastLoginAt: timestamp('last_login_at'),
	loginCount: integer('login_count').default(0),
	isLocked: boolean('is_locked').default(false),
	lockedUntil: timestamp('locked_until'),
	failedLoginAttempts: integer('failed_login_attempts').default(0),
	isGod: boolean('is_god').default(false),
	cohortId: uuid('cohort_id').references(() => userCohorts.id, { onDelete: 'set null' }),
	emailVerified: boolean('email_verified').default(false),
};

export const usersIndexes = (t: { email: PgColumn; isActive: PgColumn; lastLoginAt: PgColumn; isLocked: PgColumn; lockedUntil: PgColumn }) => [
	uniqueIndex('users_email_idx').on(t.email),
	index('users_email_is_active_idx').on(t.email, t.isActive),
	index('users_last_login_at_idx').on(t.lastLoginAt),
	index('users_is_locked_locked_until_idx').on(t.isLocked, t.lockedUntil),
];

export const users = pgTable('users', usersColumns, (t) => [
	uniqueIndex('users_email_idx').on(t.email),
	index('users_email_is_active_idx').on(t.email, t.isActive),
	index('users_last_login_at_idx').on(t.lastLoginAt),
	index('users_is_locked_locked_until_idx').on(t.isLocked, t.lockedUntil),
]);

export function createUsersForSchema(schema: ReturnType<typeof pgSchema>) {
	const userCohortsTable = schema.table('user_cohorts', userCohortsColumns);
	return schema.table('users', {
		...usersColumns,
		cohortId: uuid('cohort_id').references(() => userCohortsTable.id, { onDelete: 'set null' }),
	}, (t) => [
		uniqueIndex('users_email_idx').on(t.email),
		index('users_email_is_active_idx').on(t.email, t.isActive),
		index('users_last_login_at_idx').on(t.lastLoginAt),
		index('users_is_locked_locked_until_idx').on(t.isLocked, t.lockedUntil),
	]);
}

export const profilesColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	userId: uuid('user_id').notNull().references(() => users.id),
	firstName: varchar('first_name', { length: 100 }).notNull(),
	lastName: varchar('last_name', { length: 100 }).notNull(),
};

export const profilesIndexes = (t: { userId: PgColumn; firstName: PgColumn; lastName: PgColumn }) => [
	uniqueIndex('profiles_user_id_idx').on(t.userId),
	index('profiles_first_name_last_name_idx').on(t.firstName, t.lastName),
];

export const profiles = pgTable('profiles', profilesColumns, (t) => [
	uniqueIndex('profiles_user_id_idx').on(t.userId),
	index('profiles_first_name_last_name_idx').on(t.firstName, t.lastName),
]);

export function createProfilesForSchema(schema: ReturnType<typeof pgSchema>) {
	const usersTable = schema.table('users', usersColumns, (t) => usersIndexes(t));
	return schema.table('profiles', {
		...profilesColumns,
		userId: uuid('user_id').notNull().references(() => usersTable.id),
	}, (t) => [
		uniqueIndex('profiles_user_id_idx').on(t.userId),
		index('profiles_first_name_last_name_idx').on(t.firstName, t.lastName),
	]);
}

export const rolesColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	name: varchar('name', { length: 100 }).notNull(),
	description: varchar('description', { length: 500 }),
};

export const rolesIndexes = (t: { name: PgColumn }) => [
	uniqueIndex('roles_name_idx').on(t.name),
];

export const roles = pgTable('roles', rolesColumns, (t) => [
	uniqueIndex('roles_name_idx').on(t.name),
]);

export function createRolesForSchema(schema: ReturnType<typeof pgSchema>) {
	return schema.table('roles', rolesColumns, (t) => [
		uniqueIndex('roles_name_idx').on(t.name),
	]);
}

export const claimsColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	action: varchar('action', { length: 100 }).notNull(),
	description: varchar('description', { length: 500 }),
	path: varchar('path', { length: 200 }).notNull(),
	method: varchar('method', { length: 10 }).notNull(),
	policy: jsonb('policy'),
};

export const claimsIndexes = (t: { action: PgColumn; path: PgColumn; method: PgColumn }) => [
	uniqueIndex('claims_action_idx').on(t.action),
	index('claims_path_method_idx').on(t.path, t.method),
];

export const claims = pgTable('claims', claimsColumns, (t) => [
	uniqueIndex('claims_action_idx').on(t.action),
	index('claims_path_method_idx').on(t.path, t.method),
]);

export function createClaimsForSchema(schema: ReturnType<typeof pgSchema>) {
	return schema.table('claims', claimsColumns, (t) => [
		uniqueIndex('claims_action_idx').on(t.action),
		index('claims_path_method_idx').on(t.path, t.method),
	]);
}

export const userRolesColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
};

export const userRolesIndexes = (t: { userId: PgColumn; roleId: PgColumn }) => [
	index('user_roles_user_id_idx').on(t.userId),
	index('user_roles_role_id_idx').on(t.roleId),
];

export const userRoles = pgTable('user_roles', userRolesColumns, (t) => [
	index('user_roles_user_id_idx').on(t.userId),
	index('user_roles_role_id_idx').on(t.roleId),
]);

export function createUserRolesForSchema(schema: ReturnType<typeof pgSchema>) {
	const usersTable = schema.table('users', usersColumns, (t) => usersIndexes(t));
	const rolesTable = schema.table('roles', rolesColumns, (t) => rolesIndexes(t));
	return schema.table('user_roles', {
		...userRolesColumns,
		userId: uuid('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
		roleId: uuid('role_id').notNull().references(() => rolesTable.id, { onDelete: 'cascade' }),
	}, (t) => [
		index('user_roles_user_id_idx').on(t.userId),
		index('user_roles_role_id_idx').on(t.roleId),
	]);
}

export const roleClaimsColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
	claimId: uuid('claim_id').notNull().references(() => claims.id, { onDelete: 'cascade' }),
	scope: text('scope'),
};

export const roleClaimsIndexes = (t: { roleId: PgColumn; claimId: PgColumn; scope: PgColumn }) => [
	index('role_claims_role_id_idx').on(t.roleId),
	index('role_claims_claim_id_idx').on(t.claimId),
	index('role_claims_role_id_claim_id_scope_idx').on(t.roleId, t.claimId, t.scope),
];

export const roleClaims = pgTable('role_claims', roleClaimsColumns, (t) => [
	index('role_claims_role_id_idx').on(t.roleId),
	index('role_claims_claim_id_idx').on(t.claimId),
	index('role_claims_role_id_claim_id_scope_idx').on(t.roleId, t.claimId, t.scope),
]);

export function createRoleClaimsForSchema(schema: ReturnType<typeof pgSchema>) {
	const rolesTable = schema.table('roles', rolesColumns, (t) => rolesIndexes(t));
	const claimsTable = schema.table('claims', claimsColumns, (t) => claimsIndexes(t));
	return schema.table('role_claims', {
		...roleClaimsColumns,
		roleId: uuid('role_id').notNull().references(() => rolesTable.id, { onDelete: 'cascade' }),
		claimId: uuid('claim_id').notNull().references(() => claimsTable.id, { onDelete: 'cascade' }),
	}, (t) => [
		index('role_claims_role_id_idx').on(t.roleId),
		index('role_claims_claim_id_idx').on(t.claimId),
		index('role_claims_role_id_claim_id_scope_idx').on(t.roleId, t.claimId, t.scope),
	]);
}

export const addressesColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	ownerType: varchar('owner_type', { length: 50 }).notNull(),
	ownerId: uuid('owner_id').notNull(),
	name: varchar('name', { length: 100 }).notNull(),
	street: varchar('street', { length: 255 }),
	city: varchar('city', { length: 100 }),
	state: varchar('state', { length: 50 }),
	zip: varchar('zip', { length: 20 }),
	country: varchar('country', { length: 50 }).default('US'),
	latitude: numeric('latitude', { precision: 10, scale: 8 }),
	longitude: numeric('longitude', { precision: 11, scale: 8 }),
	neighborhood: varchar('neighborhood', { length: 100 }),
	apartment: varchar('apartment', { length: 50 }),
	province: varchar('province', { length: 100 }),
	district: varchar('district', { length: 100 }),
	type: varchar('type', { length: 50 }),
};

export const addressesIndexes = (t: { city: PgColumn; state: PgColumn; latitude: PgColumn; longitude: PgColumn; type: PgColumn; ownerType: PgColumn; ownerId: PgColumn }) => [
	index('addresses_city_state_idx').on(t.city, t.state),
	index('addresses_latitude_longitude_idx').on(t.latitude, t.longitude),
	index('addresses_type_idx').on(t.type),
	index('addresses_owner_type_owner_id_idx').on(t.ownerType, t.ownerId),
];

export const addresses = pgTable('addresses', addressesColumns, (t) => [
	index('addresses_city_state_idx').on(t.city, t.state),
	index('addresses_latitude_longitude_idx').on(t.latitude, t.longitude),
	index('addresses_type_idx').on(t.type),
	index('addresses_owner_type_owner_id_idx').on(t.ownerType, t.ownerId),
]);

export function createAddressesForSchema(schema: ReturnType<typeof pgSchema>) {
	return schema.table('addresses', addressesColumns, (t) => [
		index('addresses_city_state_idx').on(t.city, t.state),
		index('addresses_latitude_longitude_idx').on(t.latitude, t.longitude),
		index('addresses_type_idx').on(t.type),
		index('addresses_owner_type_owner_id_idx').on(t.ownerType, t.ownerId),
	]);
}

export const phonesColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	ownerType: varchar('owner_type', { length: 50 }).notNull(),
	ownerId: uuid('owner_id').notNull(),
	name: varchar('name', { length: 100 }).notNull(),
	type: varchar('type', { length: 50 }),
	number: varchar('number', { length: 20 }).notNull(),
	countryCode: varchar('country_code', { length: 10 }).notNull().default('+1'),
	extension: varchar('extension', { length: 10 }),
};

export const phonesIndexes = (t: { number: PgColumn; type: PgColumn; ownerType: PgColumn; ownerId: PgColumn }) => [
	index('phones_number_idx').on(t.number),
	index('phones_type_idx').on(t.type),
	index('phones_owner_type_owner_id_idx').on(t.ownerType, t.ownerId),
];

export const phones = pgTable('phones', phonesColumns, (t) => [
	index('phones_number_idx').on(t.number),
	index('phones_type_idx').on(t.type),
	index('phones_owner_type_owner_id_idx').on(t.ownerType, t.ownerId),
]);

export function createPhonesForSchema(schema: ReturnType<typeof pgSchema>) {
	return schema.table('phones', phonesColumns, (t) => [
		index('phones_number_idx').on(t.number),
		index('phones_type_idx').on(t.type),
		index('phones_owner_type_owner_id_idx').on(t.ownerType, t.ownerId),
	]);
}

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

export const userCohortsColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	name: varchar('name', { length: 255 }).notNull(),
	description: text('description'),
	expiresAt: timestamp('expires_at', { withTimezone: true }),
	userCount: integer('user_count').notNull().default(0),
	metadata: jsonb('metadata').default(sql`'{}'`),
};

export const userCohorts = pgTable('user_cohorts', userCohortsColumns);

export function createUserCohortsForSchema(schema: ReturnType<typeof pgSchema>) {
	return schema.table('user_cohorts', userCohortsColumns);
}

export const userSessionsColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	tokenHash: varchar('token_hash', { length: 255 }).notNull(),
	refreshTokenHash: varchar('refresh_token_hash', { length: 255 }),
	deviceFingerprint: varchar('device_fingerprint', { length: 255 }),
	deviceName: varchar('device_name', { length: 100 }),
	deviceType: varchar('device_type', { length: 50 }),
	browserName: varchar('browser_name', { length: 50 }),
	browserVersion: varchar('browser_version', { length: 20 }),
	osName: varchar('os_name', { length: 50 }),
	osVersion: varchar('os_version', { length: 20 }),
	ipAddress: varchar('ip_address', { length: 45 }).notNull(),
	locationCountry: varchar('location_country', { length: 100 }),
	locationCity: varchar('location_city', { length: 100 }),
	locationCoordinates: varchar('location_coordinates', { length: 50 }),
	lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().default(sql`now()`),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	revokedAt: timestamp('revoked_at', { withTimezone: true }),
	revokedReason: varchar('revoked_reason', { length: 100 }),
	isCurrent: boolean('is_current').notNull().default(false),
	loginMethod: varchar('login_method', { length: 50 }),
	rememberMe: boolean('remember_me').notNull().default(false),
	trustScore: integer('trust_score').default(100),
	approvalStatus: varchar('approval_status', { length: 20 }).default('approved'),
	approvalToken: varchar('approval_token', { length: 64 }),
	approvalRequestedAt: timestamp('approval_requested_at', { withTimezone: true }),
	approvalRespondedAt: timestamp('approval_responded_at', { withTimezone: true }),
};

export const userSessionsIndexes = (t: { userId: PgColumn; tokenHash: PgColumn; refreshTokenHash: PgColumn; isActive: PgColumn; expiresAt: PgColumn; deviceFingerprint: PgColumn; ipAddress: PgColumn; lastActivityAt: PgColumn; approvalStatus: PgColumn; approvalToken: PgColumn }) => [
	index('user_sessions_user_id_idx').on(t.userId),
	uniqueIndex('user_sessions_token_hash_idx').on(t.tokenHash),
	index('user_sessions_refresh_token_hash_idx').on(t.refreshTokenHash),
	index('user_sessions_user_id_is_active_idx').on(t.userId, t.isActive),
	index('user_sessions_expires_at_idx').on(t.expiresAt),
	index('user_sessions_device_fingerprint_idx').on(t.deviceFingerprint),
	index('user_sessions_ip_address_idx').on(t.ipAddress),
	index('user_sessions_last_activity_at_idx').on(t.lastActivityAt),
	index('user_sessions_approval_status_idx').on(t.approvalStatus),
	index('user_sessions_approval_token_idx').on(t.approvalToken),
];

export const userSessions = pgTable('user_sessions', userSessionsColumns, (t) => [
	index('user_sessions_user_id_idx').on(t.userId),
	uniqueIndex('user_sessions_token_hash_idx').on(t.tokenHash),
	index('user_sessions_refresh_token_hash_idx').on(t.refreshTokenHash),
	index('user_sessions_user_id_is_active_idx').on(t.userId, t.isActive),
	index('user_sessions_expires_at_idx').on(t.expiresAt),
	index('user_sessions_device_fingerprint_idx').on(t.deviceFingerprint),
	index('user_sessions_ip_address_idx').on(t.ipAddress),
	index('user_sessions_last_activity_at_idx').on(t.lastActivityAt),
	index('user_sessions_approval_status_idx').on(t.approvalStatus),
	index('user_sessions_approval_token_idx').on(t.approvalToken),
]);

export function createUserSessionsForSchema(schema: ReturnType<typeof pgSchema>) {
	const usersTable = schema.table('users', usersColumns, (t) => usersIndexes(t));
	return schema.table('user_sessions', {
		...userSessionsColumns,
		userId: uuid('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
	}, (t) => [
		index('user_sessions_user_id_idx').on(t.userId),
		uniqueIndex('user_sessions_token_hash_idx').on(t.tokenHash),
		index('user_sessions_refresh_token_hash_idx').on(t.refreshTokenHash),
		index('user_sessions_user_id_is_active_idx').on(t.userId, t.isActive),
		index('user_sessions_expires_at_idx').on(t.expiresAt),
		index('user_sessions_device_fingerprint_idx').on(t.deviceFingerprint),
		index('user_sessions_ip_address_idx').on(t.ipAddress),
		index('user_sessions_last_activity_at_idx').on(t.lastActivityAt),
		index('user_sessions_approval_status_idx').on(t.approvalStatus),
		index('user_sessions_approval_token_idx').on(t.approvalToken),
	]);
}

export const trustedDevicesColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	tokenHash: varchar('token_hash', { length: 64 }).notNull(),
	status: varchar('status', { length: 20 }).notNull().default('pending'),
	originSessionId: uuid('origin_session_id'),
	label: varchar('label', { length: 120 }),
	deviceFingerprint: varchar('device_fingerprint', { length: 255 }),
	firstSeenIp: varchar('first_seen_ip', { length: 45 }),
	lastSeenIp: varchar('last_seen_ip', { length: 45 }),
	lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
	expiresAt: timestamp('expires_at', { withTimezone: true }),
	revokedAt: timestamp('revoked_at', { withTimezone: true }),
	revokedReason: varchar('revoked_reason', { length: 30 }),
};

export const trustedDevicesIndexes = (t: { tokenHash: PgColumn; userId: PgColumn; status: PgColumn; originSessionId: PgColumn; expiresAt: PgColumn }) => [
	uniqueIndex('trusted_devices_token_hash_idx').on(t.tokenHash),
	index('trusted_devices_user_id_idx').on(t.userId),
	index('trusted_devices_user_id_status_idx').on(t.userId, t.status),
	index('trusted_devices_origin_session_id_idx').on(t.originSessionId),
	index('trusted_devices_expires_at_idx').on(t.expiresAt),
];

export const trustedDevices = pgTable('trusted_devices', trustedDevicesColumns, (t) => [
	uniqueIndex('trusted_devices_token_hash_idx').on(t.tokenHash),
	index('trusted_devices_user_id_idx').on(t.userId),
	index('trusted_devices_user_id_status_idx').on(t.userId, t.status),
	index('trusted_devices_origin_session_id_idx').on(t.originSessionId),
	index('trusted_devices_expires_at_idx').on(t.expiresAt),
]);

export function createTrustedDevicesForSchema(schema: ReturnType<typeof pgSchema>) {
	const usersTable = schema.table('users', usersColumns, (t) => usersIndexes(t));
	return schema.table('trusted_devices', {
		...trustedDevicesColumns,
		userId: uuid('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
	}, (t) => [
		uniqueIndex('trusted_devices_token_hash_idx').on(t.tokenHash),
		index('trusted_devices_user_id_idx').on(t.userId),
		index('trusted_devices_user_id_status_idx').on(t.userId, t.status),
		index('trusted_devices_origin_session_id_idx').on(t.originSessionId),
		index('trusted_devices_expires_at_idx').on(t.expiresAt),
	]);
}

export const passwordResetTokensColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	tokenHash: varchar('token_hash', { length: 255 }).notNull(),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	usedAt: timestamp('used_at', { withTimezone: true }),
};

export const passwordResetTokensIndexes = (t: { tokenHash: PgColumn; userId: PgColumn; expiresAt: PgColumn }) => [
	uniqueIndex('password_reset_tokens_token_hash_idx').on(t.tokenHash),
	index('password_reset_tokens_user_id_idx').on(t.userId),
	index('password_reset_tokens_expires_at_idx').on(t.expiresAt),
];

export const passwordResetTokens = pgTable('password_reset_tokens', passwordResetTokensColumns, (t) => [
	uniqueIndex('password_reset_tokens_token_hash_idx').on(t.tokenHash),
	index('password_reset_tokens_user_id_idx').on(t.userId),
	index('password_reset_tokens_expires_at_idx').on(t.expiresAt),
]);

export function createPasswordResetTokensForSchema(schema: ReturnType<typeof pgSchema>) {
	const usersTable = schema.table('users', usersColumns, (t) => usersIndexes(t));
	return schema.table('password_reset_tokens', {
		...passwordResetTokensColumns,
		userId: uuid('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
	}, (t) => [
		uniqueIndex('password_reset_tokens_token_hash_idx').on(t.tokenHash),
		index('password_reset_tokens_user_id_idx').on(t.userId),
		index('password_reset_tokens_expires_at_idx').on(t.expiresAt),
	]);
}

export const magicLinkTokensColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	email: varchar('email', { length: 255 }).notNull(),
	tokenHash: varchar('token_hash', { length: 255 }).notNull(),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	usedAt: timestamp('used_at', { withTimezone: true }),
};

export const magicLinkTokensIndexes = (t: { tokenHash: PgColumn; userId: PgColumn; email: PgColumn; expiresAt: PgColumn }) => [
	uniqueIndex('magic_link_tokens_token_hash_idx').on(t.tokenHash),
	index('magic_link_tokens_user_id_idx').on(t.userId),
	index('magic_link_tokens_email_idx').on(t.email),
	index('magic_link_tokens_expires_at_idx').on(t.expiresAt),
];

export const magicLinkTokens = pgTable('magic_link_tokens', magicLinkTokensColumns, (t) => [
	uniqueIndex('magic_link_tokens_token_hash_idx').on(t.tokenHash),
	index('magic_link_tokens_user_id_idx').on(t.userId),
	index('magic_link_tokens_email_idx').on(t.email),
	index('magic_link_tokens_expires_at_idx').on(t.expiresAt),
]);

export function createMagicLinkTokensForSchema(schema: ReturnType<typeof pgSchema>) {
	const usersTable = schema.table('users', usersColumns, (t) => usersIndexes(t));
	return schema.table('magic_link_tokens', {
		...magicLinkTokensColumns,
		userId: uuid('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
	}, (t) => [
		uniqueIndex('magic_link_tokens_token_hash_idx').on(t.tokenHash),
		index('magic_link_tokens_user_id_idx').on(t.userId),
		index('magic_link_tokens_email_idx').on(t.email),
		index('magic_link_tokens_expires_at_idx').on(t.expiresAt),
	]);
}

export const webauthnCredentialsColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	credentialId: text('credential_id').notNull(),
	publicKey: text('public_key').notNull(),
	counter: bigint('counter', { mode: 'number' }).notNull(),
	transports: jsonb('transports'),
	deviceType: varchar('device_type', { length: 32 }),
	backedUp: boolean('backed_up').notNull(),
	aaguid: varchar('aaguid', { length: 64 }),
	authenticatorAttachment: varchar('authenticator_attachment', { length: 32 }),
	nickname: varchar('nickname', { length: 128 }),
	lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
	revokedAt: timestamp('revoked_at', { withTimezone: true }),
};

export const webauthnCredentialsIndexes = (t: { credentialId: PgColumn; userId: PgColumn }) => [
	uniqueIndex('webauthn_credentials_credential_id_idx').on(t.credentialId),
	index('webauthn_credentials_user_id_idx').on(t.userId),
];

export const webauthnCredentials = pgTable('webauthn_credentials', webauthnCredentialsColumns, (t) => [
	uniqueIndex('webauthn_credentials_credential_id_idx').on(t.credentialId),
	index('webauthn_credentials_user_id_idx').on(t.userId),
]);

export function createWebauthnCredentialsForSchema(schema: ReturnType<typeof pgSchema>) {
	const usersTable = schema.table('users', usersColumns, (t) => usersIndexes(t));
	return schema.table('webauthn_credentials', {
		...webauthnCredentialsColumns,
		userId: uuid('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
	}, (t) => [
		uniqueIndex('webauthn_credentials_credential_id_idx').on(t.credentialId),
		index('webauthn_credentials_user_id_idx').on(t.userId),
	]);
}

export const webauthnChallengesColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
	challenge: text('challenge').notNull(),
	challengeType: varchar('challenge_type', { length: 32 }).notNull(),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	consumedAt: timestamp('consumed_at', { withTimezone: true }),
};

export const webauthnChallengesIndexes = (t: { challenge: PgColumn; userId: PgColumn; expiresAt: PgColumn }) => [
	uniqueIndex('webauthn_challenges_challenge_idx').on(t.challenge),
	index('webauthn_challenges_user_id_idx').on(t.userId),
	index('webauthn_challenges_expires_at_idx').on(t.expiresAt),
];

export const webauthnChallenges = pgTable('webauthn_challenges', webauthnChallengesColumns, (t) => [
	uniqueIndex('webauthn_challenges_challenge_idx').on(t.challenge),
	index('webauthn_challenges_user_id_idx').on(t.userId),
	index('webauthn_challenges_expires_at_idx').on(t.expiresAt),
]);

export function createWebauthnChallengesForSchema(schema: ReturnType<typeof pgSchema>) {
	const usersTable = schema.table('users', usersColumns, (t) => usersIndexes(t));
	return schema.table('webauthn_challenges', {
		...webauthnChallengesColumns,
		userId: uuid('user_id').references(() => usersTable.id, { onDelete: 'cascade' }),
	}, (t) => [
		uniqueIndex('webauthn_challenges_challenge_idx').on(t.challenge),
		index('webauthn_challenges_user_id_idx').on(t.userId),
		index('webauthn_challenges_expires_at_idx').on(t.expiresAt),
	]);
}

export const oauthAccountsColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	provider: varchar('provider', { length: 50 }).notNull(),
	providerAccountId: varchar('provider_account_id', { length: 255 }).notNull(),
	providerEmail: varchar('provider_email', { length: 255 }),
	providerName: varchar('provider_name', { length: 255 }),
	providerAvatarUrl: text('provider_avatar_url'),
	accessToken: text('access_token'),
	refreshToken: text('refresh_token'),
	tokenExpiresAt: timestamp('token_expires_at'),
	scope: text('scope'),
	rawProfile: jsonb('raw_profile'),
	isPrimary: boolean('is_primary').notNull().default(false),
	lastUsedAt: timestamp('last_used_at'),
};

export const oauthAccountsIndexes = (t: { userId: PgColumn; provider: PgColumn; providerAccountId: PgColumn; providerEmail: PgColumn }) => [
	index('oauth_accounts_user_id_idx').on(t.userId),
	uniqueIndex('oauth_accounts_provider_provider_account_id_idx').on(t.provider, t.providerAccountId),
	index('oauth_accounts_provider_email_idx').on(t.providerEmail),
	index('oauth_accounts_user_id_provider_idx').on(t.userId, t.provider),
];

export const oauthAccounts = pgTable('oauth_accounts', oauthAccountsColumns, (t) => [
	index('oauth_accounts_user_id_idx').on(t.userId),
	uniqueIndex('oauth_accounts_provider_provider_account_id_idx').on(t.provider, t.providerAccountId),
	index('oauth_accounts_provider_email_idx').on(t.providerEmail),
	index('oauth_accounts_user_id_provider_idx').on(t.userId, t.provider),
]);

export function createOauthAccountsForSchema(schema: ReturnType<typeof pgSchema>) {
	const usersTable = schema.table('users', usersColumns, (t) => usersIndexes(t));
	return schema.table('oauth_accounts', {
		...oauthAccountsColumns,
		userId: uuid('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
	}, (t) => [
		index('oauth_accounts_user_id_idx').on(t.userId),
		uniqueIndex('oauth_accounts_provider_provider_account_id_idx').on(t.provider, t.providerAccountId),
		index('oauth_accounts_provider_email_idx').on(t.providerEmail),
		index('oauth_accounts_user_id_provider_idx').on(t.userId, t.provider),
	]);
}

export const apiKeysColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	name: varchar('name', { length: 255 }).notNull(),
	description: text('description'),
	keyHash: varchar('key_hash', { length: 255 }).notNull(),
	keyPreview: varchar('key_preview', { length: 20 }).notNull(),
	ownerType: varchar('owner_type', { length: 30 }).notNull().default('personal'),
	applicationName: varchar('application_name', { length: 255 }),
	allowedRoles: jsonb('allowed_roles').notNull().default(sql`'[]'`),
	allowedClaims: jsonb('allowed_claims').notNull().default(sql`'[]'`),
	allowedScopes: jsonb('allowed_scopes').notNull().default(sql`'[]'`),
	expiresAt: timestamp('expires_at', { withTimezone: true }),
	lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
	lastUsedIp: varchar('last_used_ip', { length: 45 }),
	usageCount: integer('usage_count').notNull().default(0),
	revokedAt: timestamp('revoked_at', { withTimezone: true }),
	revokedReason: varchar('revoked_reason', { length: 255 }),
};

export const apiKeysIndexes = (t: { keyHash: PgColumn; userId: PgColumn; isActive: PgColumn; ownerType: PgColumn; expiresAt: PgColumn; lastUsedAt: PgColumn }) => [
	uniqueIndex('api_keys_key_hash_idx').on(t.keyHash),
	index('api_keys_user_id_idx').on(t.userId),
	index('api_keys_user_id_is_active_idx').on(t.userId, t.isActive),
	index('api_keys_owner_type_idx').on(t.ownerType),
	index('api_keys_expires_at_idx').on(t.expiresAt),
	index('api_keys_last_used_at_idx').on(t.lastUsedAt),
];

export const apiKeys = pgTable('api_keys', apiKeysColumns, (t) => [
	uniqueIndex('api_keys_key_hash_idx').on(t.keyHash),
	index('api_keys_user_id_idx').on(t.userId),
	index('api_keys_user_id_is_active_idx').on(t.userId, t.isActive),
	index('api_keys_owner_type_idx').on(t.ownerType),
	index('api_keys_expires_at_idx').on(t.expiresAt),
	index('api_keys_last_used_at_idx').on(t.lastUsedAt),
]);

export function createApiKeysForSchema(schema: ReturnType<typeof pgSchema>) {
	const usersTable = schema.table('users', usersColumns, (t) => usersIndexes(t));
	return schema.table('api_keys', {
		...apiKeysColumns,
		userId: uuid('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
	}, (t) => [
		uniqueIndex('api_keys_key_hash_idx').on(t.keyHash),
		index('api_keys_user_id_idx').on(t.userId),
		index('api_keys_user_id_is_active_idx').on(t.userId, t.isActive),
		index('api_keys_owner_type_idx').on(t.ownerType),
		index('api_keys_expires_at_idx').on(t.expiresAt),
		index('api_keys_last_used_at_idx').on(t.lastUsedAt),
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
	contentSha256: char('content_sha256', { length: 64 }).notNull(),
	rowCount: bigint('row_count', { mode: 'number' }).notNull(),
	schemaSummary: jsonb('schema_summary').notNull(),
	frozenAt: timestamp('frozen_at', { withTimezone: true }).notNull(),
};

export const datasetSnapshotsIndexes = (t: { datasetDefinitionId: PgColumn; contentSha256: PgColumn }) => [
	uniqueIndex('uq_dataset_snapshots_definition_content').on(t.datasetDefinitionId, t.contentSha256),
];

export const datasetSnapshots = pgTable('dataset_snapshots', datasetSnapshotsColumns, (t) => [
	uniqueIndex('uq_dataset_snapshots_definition_content').on(t.datasetDefinitionId, t.contentSha256),
]);

export function createDatasetSnapshotsForSchema(schema: ReturnType<typeof pgSchema>) {
	const datasetDefinitionsTable = schema.table('dataset_definitions', datasetDefinitionsColumns);
	return schema.table('dataset_snapshots', {
		...datasetSnapshotsColumns,
		datasetDefinitionId: uuid('dataset_definition_id').notNull().references(() => datasetDefinitionsTable.id, { onDelete: 'cascade' }),
	}, (t) => [
		uniqueIndex('uq_dataset_snapshots_definition_content').on(t.datasetDefinitionId, t.contentSha256),
	]);
}

export const trainingJobsColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	datasetSnapshotId: uuid('dataset_snapshot_id').notNull().references(() => datasetSnapshots.id, { onDelete: 'restrict' }),
	fingerprint: char('fingerprint', { length: 64 }).notNull(),
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
	workerLog: text('worker_log'),
	maxRuntimeSeconds: integer('max_runtime_seconds').notNull(),
};

export const trainingJobsIndexes = (t: { fingerprint: PgColumn }) => [
	index('idx_training_jobs_fingerprint').on(t.fingerprint),
];

export const trainingJobs = pgTable('training_jobs', trainingJobsColumns, (t) => [
	index('idx_training_jobs_fingerprint').on(t.fingerprint),
]);

export function createTrainingJobsForSchema(schema: ReturnType<typeof pgSchema>) {
	const datasetSnapshotsTable = schema.table('dataset_snapshots', datasetSnapshotsColumns, (t) => datasetSnapshotsIndexes(t));
	return schema.table('training_jobs', {
		...trainingJobsColumns,
		datasetSnapshotId: uuid('dataset_snapshot_id').notNull().references(() => datasetSnapshotsTable.id, { onDelete: 'restrict' }),
	}, (t) => [
		index('idx_training_jobs_fingerprint').on(t.fingerprint),
	]);
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
	publishedBy: uuid('published_by').references(() => users.id, { onDelete: 'set null' }),
	retiredAt: timestamp('retired_at', { withTimezone: true }),
	retiredBy: uuid('retired_by'),
};

export const modelVersions = pgTable('model_versions', modelVersionsColumns);

export function createModelVersionsForSchema(schema: ReturnType<typeof pgSchema>) {
	const datasetDefinitionsTable = schema.table('dataset_definitions', datasetDefinitionsColumns);
	const trainingJobsTable = schema.table('training_jobs', trainingJobsColumns, (t) => trainingJobsIndexes(t));
	const usersTable = schema.table('users', usersColumns, (t) => usersIndexes(t));
	return schema.table('model_versions', {
		...modelVersionsColumns,
		datasetDefinitionId: uuid('dataset_definition_id').notNull().references(() => datasetDefinitionsTable.id, { onDelete: 'restrict' }),
		trainingJobId: uuid('training_job_id').notNull().references(() => trainingJobsTable.id, { onDelete: 'restrict' }),
		parentVersionId: uuid('parent_version_id'),
		publishedBy: uuid('published_by').references(() => usersTable.id, { onDelete: 'set null' }),
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

export const userLlmSettingsColumns = {
	id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
	isActive: boolean('is_active').notNull().default(true),
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
	userId: uuid('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
	mode: varchar('mode', { length: 20 }).notNull(),
	apiFormat: varchar('api_format', { length: 30 }),
	modelName: varchar('model_name', { length: 200 }).notNull(),
	baseUrl: text('base_url').notNull(),
	encryptedApiKey: text('encrypted_api_key'),
	reasoningEffort: varchar('reasoning_effort', { length: 20 }),
};

export const userLlmSettings = pgTable('user_llm_settings', userLlmSettingsColumns);

export function createUserLlmSettingsForSchema(schema: ReturnType<typeof pgSchema>) {
	const usersTable = schema.table('users', usersColumns, (t) => usersIndexes(t));
	return schema.table('user_llm_settings', {
		...userLlmSettingsColumns,
		userId: uuid('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
	});
}

export function createAllTablesForSchema(schema: ReturnType<typeof pgSchema>) {
	const tables: Record<string, unknown> = {};

	tables.userCohorts = createUserCohortsForSchema(schema);
	tables.users = createUsersForSchema(schema);
	tables.profiles = createProfilesForSchema(schema);
	tables.roles = createRolesForSchema(schema);
	tables.claims = createClaimsForSchema(schema);
	tables.userRoles = createUserRolesForSchema(schema);
	tables.roleClaims = createRoleClaimsForSchema(schema);
	tables.addresses = createAddressesForSchema(schema);
	tables.phones = createPhonesForSchema(schema);
	tables.tenants = createTenantsForSchema(schema);
	tables.tenantEvents = createTenantEventsForSchema(schema);
	tables.tenantFeatures = createTenantFeaturesForSchema(schema);
	tables.userSessions = createUserSessionsForSchema(schema);
	tables.trustedDevices = createTrustedDevicesForSchema(schema);
	tables.passwordResetTokens = createPasswordResetTokensForSchema(schema);
	tables.magicLinkTokens = createMagicLinkTokensForSchema(schema);
	tables.webauthnCredentials = createWebauthnCredentialsForSchema(schema);
	tables.webauthnChallenges = createWebauthnChallengesForSchema(schema);
	tables.oauthAccounts = createOauthAccountsForSchema(schema);
	tables.apiKeys = createApiKeysForSchema(schema);
	tables.datasetDefinitions = createDatasetDefinitionsForSchema(schema);
	tables.datasetColumns = createDatasetColumnsForSchema(schema);
	tables.datasetSnapshots = createDatasetSnapshotsForSchema(schema);
	tables.trainingJobs = createTrainingJobsForSchema(schema);
	tables.modelVersions = createModelVersionsForSchema(schema);
	tables.modelArtifacts = createModelArtifactsForSchema(schema);
	tables.modelFeatures = createModelFeaturesForSchema(schema);
	tables.toolDefinitions = createToolDefinitionsForSchema(schema);
	tables.inferenceCalls = createInferenceCallsForSchema(schema);
	tables.userLlmSettings = createUserLlmSettingsForSchema(schema);

	return tables;
}
