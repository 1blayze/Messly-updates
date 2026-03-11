import { supabase } from "./client";
import {
  resolvePresenceSnapshotFromRow,
  type PresenceTableRow,
} from "../services/presence/presenceTypes";
import { mapPresenceSnapshotToEntity, type UserPresenceEntity } from "../stores/entities";
import {
  getPresenceTableColumnCapabilities,
  getPresenceTableName,
  resolvePresenceSelectColumns,
} from "../services/presence/presenceTable";

export async function fetchPresenceSnapshots(userIds: string[]): Promise<UserPresenceEntity[]> {
  const normalizedUserIds = [...new Set(userIds.map((userId) => String(userId ?? "").trim()).filter(Boolean))];
  if (normalizedUserIds.length === 0) {
    return [];
  }

  const tableName = await getPresenceTableName();
  const { hasActivitiesColumn } = await getPresenceTableColumnCapabilities();
  const selectColumns = resolvePresenceSelectColumns(hasActivitiesColumn);
  const { data, error } = await supabase
    .from(tableName)
    .select(selectColumns)
    .in("user_id", normalizedUserIds);

  if (error) {
    throw error;
  }

  return (((data ?? []) as unknown) as PresenceTableRow[])
    .map((row) => resolvePresenceSnapshotFromRow(row))
    .map((snapshot) => mapPresenceSnapshotToEntity(snapshot));
}
