-- AlterTable
-- A munkalap a karbantartasi lap felelosait koveti (kartya d91005e9). Az alap HAMIS: a mar meglevo lapok mind onallok,
-- a karbantartasi lap felelos-valtozasa oket nem irja at.
ALTER TABLE "Worksheet" ADD COLUMN "followsJobAssignees" BOOLEAN NOT NULL DEFAULT false;
