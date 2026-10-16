import { describeAdapterConformance } from "../../conformance/vitest.js";
import { fakeConformanceFixture } from "../helpers/conformance-fixtures.js";

const defaults = fakeConformanceFixture({ fault: "busyWithoutFlag" });
describeAdapterConformance("fault with default expectations", defaults.makeAdapter, defaults.profile);

const pinned = fakeConformanceFixture({ fault: "busyWithoutFlag" });
describeAdapterConformance("fault with pinned expectation", pinned.makeAdapter, pinned.profile, { C5: "fail" });
