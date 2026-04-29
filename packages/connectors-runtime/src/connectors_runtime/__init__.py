"""pcc-connectors-runtime: REST sidecar wrapping dlt (data load tool).

Exposes source / destination / pipeline primitives so TS connector shells
(`@pcc/connectors-{postgres,salesforce,sharepoint,sap,csv}`) can stay 100%
TypeScript and call us over plain HTTP. The Python interpreter never enters
the TS dependency tree.

Lives on Spark via systemd --user. The PCC gateway will eventually proxy
the public surface under `/api/connectors/*` (Wave 4); for now the TS
shells call us directly via `CONNECTORS_RUNTIME_URL`.
"""

__version__ = "0.1.0"
