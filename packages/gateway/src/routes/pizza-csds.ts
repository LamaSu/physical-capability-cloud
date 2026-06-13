/**
 * pizza-csds.ts — Capability StructureDefinitions for the vibecodenights demo.
 *
 * The compose seed (`scripts/seed-pizza-demo.ts`) registers make-pizza /
 * delivered-pizza as compose candidates + graph nodes, but those carry only
 * price/eta/tier — not the *parameter shape* a user's agent needs to know what
 * to ask. These CSDs supply that shape so `GET /api/csd/by-type/make-pizza`
 * returns a real, machine-readable spec the LLM agent reads before clarifying.
 *
 * Registered into the shared CSD registry at boot by csd.ts. The demo uses a
 * free-text `description` on /api/demo/pizza-order as the transport (so any shop
 * can fulfil), but these parameters tell the agent which details actually
 * matter — and which carry sensible defaults vs. which must be confirmed.
 */

import type { CSD } from "@pcc/spec";

export const MAKE_PIZZA_CSD: CSD = {
  $schema: "https://pcc.network/schemas/csd/v1",
  url: "pcc://capabilities/make-pizza/v1",
  version: "1.0.0",
  status: "active",
  name: "Make Pizza",
  description:
    "Prepare and bake a pizza to order. The user's agent collects these parameters, then packs them into the free-text description sent to /api/demo/pizza-order.",
  kind: "base",
  baseDefinition: null,
  parameters: [
    {
      type: "enum",
      key: "size",
      label: "Size",
      description: "Pizza diameter. No default — always ask.",
      required: true,
      order: 1,
      group: "Pizza",
      options: [
        { value: "small", label: 'Small (10")' },
        { value: "medium", label: 'Medium (12")' },
        { value: "large", label: 'Large (14")' },
        { value: "xl", label: 'Extra Large (16")' },
      ],
    },
    {
      type: "enum",
      key: "crust",
      label: "Crust",
      description: "Crust style.",
      required: false,
      order: 2,
      group: "Pizza",
      defaultValue: "classic",
      options: [
        { value: "thin", label: "Thin" },
        { value: "classic", label: "Classic Hand-Tossed" },
        { value: "deep-dish", label: "Deep Dish" },
        { value: "stuffed", label: "Stuffed Crust" },
        { value: "gluten-free", label: "Gluten-Free" },
      ],
    },
    {
      type: "enum",
      key: "sauce",
      label: "Sauce",
      description: "Base sauce.",
      required: false,
      order: 3,
      group: "Pizza",
      defaultValue: "tomato",
      options: [
        { value: "tomato", label: "Tomato" },
        { value: "white", label: "White / Garlic Cream" },
        { value: "bbq", label: "BBQ" },
        { value: "pesto", label: "Pesto" },
        { value: "none", label: "No Sauce" },
      ],
    },
    {
      type: "enum",
      key: "toppings",
      label: "Toppings",
      description: "Pick any number. Cheese is included by default.",
      required: false,
      order: 4,
      group: "Pizza",
      multi: true,
      options: [
        { value: "extra-cheese", label: "Extra Cheese" },
        { value: "pepperoni", label: "Pepperoni" },
        { value: "sausage", label: "Sausage" },
        { value: "chicken", label: "Grilled Chicken" },
        { value: "mushroom", label: "Mushroom" },
        { value: "onion", label: "Onion" },
        { value: "bell-pepper", label: "Bell Pepper" },
        { value: "olive", label: "Olive" },
        { value: "jalapeno", label: "Jalapeño" },
        { value: "pineapple", label: "Pineapple" },
        { value: "basil", label: "Fresh Basil" },
        { value: "anchovy", label: "Anchovy" },
      ],
    },
    {
      type: "enum",
      key: "dietary",
      label: "Dietary",
      description:
        "Dietary requirement. Defaults to none, but ALWAYS confirm — a wrong assumption here is harmful.",
      required: false,
      order: 5,
      group: "Dietary",
      multi: true,
      defaultValue: "none",
      options: [
        { value: "none", label: "No restriction" },
        { value: "vegetarian", label: "Vegetarian" },
        { value: "vegan", label: "Vegan" },
        { value: "halal", label: "Halal" },
        { value: "gluten-free", label: "Gluten-Free" },
        { value: "dairy-free", label: "Dairy-Free" },
      ],
    },
    {
      type: "number",
      key: "quantity",
      label: "Quantity",
      description: "Number of pizzas. Confirm if more than one.",
      required: true,
      order: 6,
      group: "Order",
      min: 1,
      max: 20,
      step: 1,
      unit: "pizzas",
      defaultValue: 1,
    },
    {
      type: "string",
      key: "notes",
      label: "Special instructions",
      description: "Anything else the kitchen should know (well done, cut in squares, etc.).",
      required: false,
      order: 7,
      group: "Order",
      maxLength: 280,
      placeholder: "e.g. light on the sauce, cut into squares",
    },
  ],
  constraints: [
    {
      key: "pizza-vegan-no-animal",
      human: "Vegan pizzas cannot have cheese, meat, or anchovy toppings.",
      severity: "error",
      when: [{ param: "dietary", operator: "in", value: ["vegan"] }],
      then: [
        {
          action: "exclude",
          param: "toppings",
          values: ["extra-cheese", "pepperoni", "sausage", "chicken", "anchovy"],
        },
      ],
    },
    {
      key: "pizza-vegetarian-no-meat",
      human: "Vegetarian pizzas cannot have meat or anchovy toppings.",
      severity: "error",
      when: [{ param: "dietary", operator: "in", value: ["vegetarian"] }],
      then: [
        {
          action: "exclude",
          param: "toppings",
          values: ["pepperoni", "sausage", "chicken", "anchovy"],
        },
      ],
    },
    {
      key: "pizza-gf-crust",
      human: "Gluten-free orders must use the gluten-free crust.",
      severity: "warning",
      when: [{ param: "dietary", operator: "in", value: ["gluten-free"] }],
      then: [{ action: "restrictTo", param: "crust", values: ["gluten-free"] }],
    },
  ],
  pricing: {
    basePrice: "12.00",
    currency: "USDC",
    unit: "per pizza",
  },
};

export const DELIVERED_PIZZA_CSD: CSD = {
  $schema: "https://pcc.network/schemas/csd/v1",
  url: "pcc://capabilities/delivered-pizza/v1",
  version: "1.0.0",
  status: "active",
  name: "Pizza Delivery",
  description:
    "Pick a finished pizza up from the shop and deliver it to the user's address. The second step in the make-pizza → delivered-pizza chain.",
  kind: "base",
  baseDefinition: null,
  parameters: [
    {
      type: "enum",
      key: "urgency",
      label: "Urgency",
      description: "How fast the user needs it.",
      required: false,
      order: 1,
      group: "Delivery",
      defaultValue: "standard",
      options: [
        { value: "standard", label: "Standard" },
        {
          value: "express",
          label: "Express (priority driver)",
          pricingImpact: { mode: "percent", value: "40", label: "+40% express" },
        },
      ],
    },
    {
      type: "boolean",
      key: "contactless",
      label: "Contactless drop-off",
      description: "Leave at the door instead of hand-off.",
      required: false,
      order: 2,
      group: "Delivery",
      defaultValue: true,
    },
    {
      type: "string",
      key: "dropoffNotes",
      label: "Drop-off notes",
      description: "Gate code, floor, buzzer, landmark — anything the driver needs.",
      required: false,
      order: 3,
      group: "Delivery",
      maxLength: 200,
      placeholder: "e.g. gate code 4417, 3rd floor, leave at door",
    },
    {
      type: "number",
      key: "tip",
      label: "Driver tip",
      description: "Optional tip for the driver, added on top.",
      required: false,
      order: 4,
      group: "Delivery",
      min: 0,
      max: 100,
      step: 1,
      unit: "USDC",
      defaultValue: 0,
    },
  ],
  constraints: [],
  pricing: {
    basePrice: "5.00",
    currency: "USDC",
    unit: "per delivery",
  },
};

/**
 * The demo pizza CSDs, surfaced by `GET /api/csd/by-type/:type`. Demo-scoped —
 * intentionally NOT registered into the @pcc/spec builtin registry, so the
 * builtin catalog (`GET /api/csd`) stays exactly the built-in set.
 */
export const PIZZA_CSDS: readonly CSD[] = [MAKE_PIZZA_CSD, DELIVERED_PIZZA_CSD];
