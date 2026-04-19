import { db, notifications } from "./db";
import { generateId } from "./id";

export type NotificationType =
  | "trade_proposed"
  | "trade_accepted"
  | "trade_rejected"
  | "trade_approved"
  | "trade_admin_rejected"
  | "trade_cancelled";

export interface CreateNotificationInput {
  teamId: string;
  leagueId: string;
  type: NotificationType;
  title: string;
  body: string;
  link?: string;
}

export async function createNotification(input: CreateNotificationInput): Promise<void> {
  await db.insert(notifications).values({
    id: generateId(),
    teamId: input.teamId,
    leagueId: input.leagueId,
    type: input.type,
    title: input.title,
    body: input.body,
    link: input.link ?? null,
  });
}
