CREATE INDEX IF NOT EXISTS food_consumption_events_created_by_idx ON public.food_consumption_events (created_by);
CREATE INDEX IF NOT EXISTS food_consumption_events_food_id_idx ON public.food_consumption_events (food_id);
CREATE INDEX IF NOT EXISTS food_consumption_rules_created_by_idx ON public.food_consumption_rules (created_by);
CREATE INDEX IF NOT EXISTS household_invites_created_by_idx ON public.household_invites (created_by);
CREATE INDEX IF NOT EXISTS recurring_shopping_items_created_by_idx ON public.recurring_shopping_items (created_by);
CREATE INDEX IF NOT EXISTS shopping_items_created_by_idx ON public.shopping_items (created_by);
CREATE INDEX IF NOT EXISTS shopping_items_linked_food_id_idx ON public.shopping_items (linked_food_id);
CREATE INDEX IF NOT EXISTS shopping_items_purchased_by_idx ON public.shopping_items (purchased_by);
