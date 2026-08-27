import { relations } from 'drizzle-orm';
import { users, profiles, roles, claims, userRoles, roleClaims, addresses, phones, tenants, tenantEvents, tenantFeatures, userCohorts, userSessions, trustedDevices, passwordResetTokens, magicLinkTokens, webauthnCredentials, webauthnChallenges, oauthAccounts, apiKeys, datasetDefinitions, datasetColumns, datasetSnapshots, trainingJobs, modelVersions, modelArtifacts, modelFeatures, toolDefinitions, inferenceCalls, userLlmSettings } from './schema';

export const usersRelations = relations(users, ({ one, many }) => ({
	userCohorts: one(userCohorts, {
		fields: [users.cohortId],
		references: [userCohorts.id],
	}),
}));

export const profilesRelations = relations(profiles, ({ one, many }) => ({
	users: one(users, {
		fields: [profiles.userId],
		references: [users.id],
	}),
}));

export const userRolesRelations = relations(userRoles, ({ one, many }) => ({
	users: one(users, {
		fields: [userRoles.userId],
		references: [users.id],
	}),
	roles: one(roles, {
		fields: [userRoles.roleId],
		references: [roles.id],
	}),
}));

export const roleClaimsRelations = relations(roleClaims, ({ one, many }) => ({
	roles: one(roles, {
		fields: [roleClaims.roleId],
		references: [roles.id],
	}),
	claims: one(claims, {
		fields: [roleClaims.claimId],
		references: [claims.id],
	}),
}));

export const tenantEventsRelations = relations(tenantEvents, ({ one, many }) => ({
	tenants: one(tenants, {
		fields: [tenantEvents.tenantId],
		references: [tenants.id],
	}),
}));

export const tenantFeaturesRelations = relations(tenantFeatures, ({ one, many }) => ({
	tenants: one(tenants, {
		fields: [tenantFeatures.tenantId],
		references: [tenants.id],
	}),
}));

export const userCohortsRelations = relations(userCohorts, ({ one, many }) => ({
	users: one(users, {
		fields: [userCohorts.createdBy],
		references: [users.id],
	}),
}));

export const userSessionsRelations = relations(userSessions, ({ one, many }) => ({
	users: one(users, {
		fields: [userSessions.userId],
		references: [users.id],
	}),
}));

export const trustedDevicesRelations = relations(trustedDevices, ({ one, many }) => ({
	users: one(users, {
		fields: [trustedDevices.userId],
		references: [users.id],
	}),
}));

export const passwordResetTokensRelations = relations(passwordResetTokens, ({ one, many }) => ({
	users: one(users, {
		fields: [passwordResetTokens.userId],
		references: [users.id],
	}),
}));

export const magicLinkTokensRelations = relations(magicLinkTokens, ({ one, many }) => ({
	users: one(users, {
		fields: [magicLinkTokens.userId],
		references: [users.id],
	}),
}));

export const webauthnCredentialsRelations = relations(webauthnCredentials, ({ one, many }) => ({
	users: one(users, {
		fields: [webauthnCredentials.userId],
		references: [users.id],
	}),
}));

export const webauthnChallengesRelations = relations(webauthnChallenges, ({ one, many }) => ({
	users: one(users, {
		fields: [webauthnChallenges.userId],
		references: [users.id],
	}),
}));

export const oauthAccountsRelations = relations(oauthAccounts, ({ one, many }) => ({
	users: one(users, {
		fields: [oauthAccounts.userId],
		references: [users.id],
	}),
}));

export const apiKeysRelations = relations(apiKeys, ({ one, many }) => ({
	users: one(users, {
		fields: [apiKeys.userId],
		references: [users.id],
	}),
}));

export const datasetColumnsRelations = relations(datasetColumns, ({ one, many }) => ({
	datasetDefinitions: one(datasetDefinitions, {
		fields: [datasetColumns.datasetDefinitionId],
		references: [datasetDefinitions.id],
	}),
}));

export const datasetSnapshotsRelations = relations(datasetSnapshots, ({ one, many }) => ({
	datasetDefinitions: one(datasetDefinitions, {
		fields: [datasetSnapshots.datasetDefinitionId],
		references: [datasetDefinitions.id],
	}),
}));

export const trainingJobsRelations = relations(trainingJobs, ({ one, many }) => ({
	datasetSnapshots: one(datasetSnapshots, {
		fields: [trainingJobs.datasetSnapshotId],
		references: [datasetSnapshots.id],
	}),
}));

export const modelVersionsRelations = relations(modelVersions, ({ one, many }) => ({
	datasetDefinitions: one(datasetDefinitions, {
		fields: [modelVersions.datasetDefinitionId],
		references: [datasetDefinitions.id],
	}),
	trainingJobs: one(trainingJobs, {
		fields: [modelVersions.trainingJobId],
		references: [trainingJobs.id],
	}),
	parent: one(modelVersions, {
		fields: [modelVersions.parentVersionId],
		references: [modelVersions.id],
	}),
	users: one(users, {
		fields: [modelVersions.publishedBy],
		references: [users.id],
	}),
}));

export const modelArtifactsRelations = relations(modelArtifacts, ({ one, many }) => ({
	modelVersions: one(modelVersions, {
		fields: [modelArtifacts.modelVersionId],
		references: [modelVersions.id],
	}),
}));

export const modelFeaturesRelations = relations(modelFeatures, ({ one, many }) => ({
	modelVersions: one(modelVersions, {
		fields: [modelFeatures.modelVersionId],
		references: [modelVersions.id],
	}),
}));

export const toolDefinitionsRelations = relations(toolDefinitions, ({ one, many }) => ({
	modelVersions: one(modelVersions, {
		fields: [toolDefinitions.modelVersionId],
		references: [modelVersions.id],
	}),
}));

export const inferenceCallsRelations = relations(inferenceCalls, ({ one, many }) => ({
	toolDefinitions: one(toolDefinitions, {
		fields: [inferenceCalls.toolDefinitionId],
		references: [toolDefinitions.id],
	}),
	modelVersions: one(modelVersions, {
		fields: [inferenceCalls.modelVersionId],
		references: [modelVersions.id],
	}),
}));

export const userLlmSettingsRelations = relations(userLlmSettings, ({ one, many }) => ({
	users: one(users, {
		fields: [userLlmSettings.userId],
		references: [users.id],
	}),
}));

