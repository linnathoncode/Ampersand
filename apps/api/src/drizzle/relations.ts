import { relations } from 'drizzle-orm';
import { tenants, tenantEvents, tenantFeatures, datasetDefinitions, datasetColumns, datasetSnapshots, trainingJobs, modelVersions, modelArtifacts, modelFeatures, toolDefinitions, inferenceCalls } from './schema';

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

