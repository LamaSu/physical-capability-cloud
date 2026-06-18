import type Database from "better-sqlite3";

/**
 * Creates all tables using raw SQL via better-sqlite3.
 * This avoids needing drizzle-kit at runtime.
 */
export function migrateDatabase(sqlite: Database.Database): void {
  // Disable FK enforcement — we handle referential integrity at the application layer.
  // This prevents insert failures when tables reference kernels that haven't been seeded yet.
  sqlite.pragma("foreign_keys = OFF");

  sqlite.exec(`
    -- ── Kernels ──────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS shop_kernels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      operator_address TEXT NOT NULL,
      location TEXT NOT NULL,  -- JSON { lat, lng }
      physical_address TEXT NOT NULL,
      max_assurance_tier INTEGER NOT NULL,
      public_key TEXT NOT NULL,
      reputation INTEGER NOT NULL DEFAULT 0,
      total_jobs_completed INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      last_heartbeat TEXT NOT NULL,
      version TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kernel_devices (
      id TEXT PRIMARY KEY,
      kernel_id TEXT NOT NULL ,
      type TEXT NOT NULL,
      model TEXT NOT NULL,
      firmware TEXT NOT NULL,
      status TEXT NOT NULL,
      contributes_to_capabilities TEXT NOT NULL,  -- JSON string[]
      last_updated TEXT NOT NULL,
      adapter_type TEXT,                          -- "octoprint" | "modbus" | "opcua" | "sila" | "generic-http" | NULL
      adapter_config TEXT,                        -- JSON adapter-specific config
      capabilities TEXT,                          -- JSON string[] of capability IDs
      health_status TEXT NOT NULL DEFAULT 'unknown',  -- "healthy" | "degraded" | "offline" | "unknown"
      last_health_check INTEGER                   -- unix timestamp
    );

    -- ── Capabilities ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS capabilities (
      id TEXT PRIMARY KEY,
      kernel_id TEXT NOT NULL ,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      materials TEXT NOT NULL,  -- JSON string[]
      tolerances TEXT,  -- JSON
      envelope TEXT,  -- JSON
      assurance_tiers TEXT NOT NULL,  -- JSON number[]
      pricing TEXT NOT NULL,  -- JSON
      availability TEXT NOT NULL,  -- JSON
      location TEXT NOT NULL,  -- JSON { lat, lng }
      queue_depth INTEGER NOT NULL DEFAULT 0,
      tags TEXT  -- JSON string[]
    );

    -- ── Jobs ─────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      step_id TEXT NOT NULL,
      cwm_id TEXT NOT NULL,
      capability_id TEXT NOT NULL REFERENCES capabilities(id),
      kernel_id TEXT NOT NULL ,
      status TEXT NOT NULL,
      assigned_devices TEXT NOT NULL,  -- JSON string[]
      started_at TEXT,
      completed_at TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      evidence_bundle_id TEXT,
      parameters TEXT
    );

    -- ── Evidence ─────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS evidence_bundles (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      step_id TEXT NOT NULL,
      kernel_id TEXT NOT NULL ,
      assurance_tier INTEGER NOT NULL,
      bundle_hash TEXT NOT NULL,
      kernel_signature TEXT NOT NULL,  -- JSON
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evidence_events (
      id TEXT PRIMARY KEY,
      bundle_id TEXT NOT NULL REFERENCES evidence_bundles(id),
      type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      source TEXT NOT NULL,  -- JSON
      payload TEXT NOT NULL,  -- JSON
      hash TEXT NOT NULL
    );

    -- ── Settlement ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS escrows (
      id TEXT PRIMARY KEY,
      cwm_id TEXT NOT NULL,
      contract_address TEXT NOT NULL,
      payer TEXT NOT NULL,
      total_amount TEXT NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deadline TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS escrow_milestones (
      id TEXT PRIMARY KEY,
      escrow_id TEXT NOT NULL REFERENCES escrows(id),
      step_id TEXT NOT NULL,
      amount TEXT NOT NULL,
      status TEXT NOT NULL,
      evidence_bundle_hash TEXT,
      verifier_attestation_hash TEXT,
      challenge_window_start TEXT,
      challenge_window_end TEXT,
      bond_amount TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS disputes (
      id TEXT PRIMARY KEY,
      escrow_id TEXT NOT NULL REFERENCES escrows(id),
      milestone_step_id TEXT NOT NULL,
      challenger TEXT NOT NULL,
      challenger_bond TEXT NOT NULL,
      reason TEXT NOT NULL,
      challenger_evidence_hash TEXT,
      status TEXT NOT NULL,
      arbiters TEXT,  -- JSON string[]
      resolution TEXT,  -- JSON
      filed_at TEXT NOT NULL
    );

    -- ── Orchestrator ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS transfer_graphs (
      id TEXT PRIMARY KEY,
      kernel_id TEXT NOT NULL ,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS transfer_nodes (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL REFERENCES transfer_graphs(id),
      kernel_id TEXT NOT NULL ,
      device_id TEXT,
      label TEXT NOT NULL,
      node_type TEXT NOT NULL,
      capabilities TEXT NOT NULL,  -- JSON string[]
      position TEXT,  -- JSON { x, y, z? }
      metadata TEXT  -- JSON
    );

    CREATE TABLE IF NOT EXISTS transfer_edges (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL REFERENCES transfer_graphs(id),
      from_node_id TEXT NOT NULL REFERENCES transfer_nodes(id),
      to_node_id TEXT NOT NULL REFERENCES transfer_nodes(id),
      mechanism TEXT NOT NULL,
      transfer_time_ms INTEGER NOT NULL,
      bidirectional INTEGER NOT NULL,
      constraints TEXT,  -- JSON
      transfer_agent_id TEXT,
      automation_level TEXT,
      episode_count INTEGER,
      vla_model_id TEXT,
      vla_success_rate REAL
    );

    CREATE TABLE IF NOT EXISTS samples (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      label TEXT NOT NULL,
      labware_type TEXT NOT NULL,
      current_node_id TEXT NOT NULL REFERENCES transfer_nodes(id),
      status TEXT NOT NULL,
      metadata TEXT,  -- JSON
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sample_movements (
      id TEXT PRIMARY KEY,
      sample_id TEXT NOT NULL REFERENCES samples(id),
      from_node_id TEXT NOT NULL REFERENCES transfer_nodes(id),
      to_node_id TEXT NOT NULL REFERENCES transfer_nodes(id),
      mechanism TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      evidence_hash TEXT
    );

    CREATE TABLE IF NOT EXISTS instrument_workflows (
      id TEXT PRIMARY KEY,
      kernel_id TEXT NOT NULL ,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      status TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS instrument_steps (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES instrument_workflows(id),
      node_id TEXT NOT NULL REFERENCES transfer_nodes(id),
      action TEXT NOT NULL,
      params TEXT NOT NULL,  -- JSON
      estimated_duration_ms INTEGER NOT NULL,
      required_labware TEXT,
      produces_evidence INTEGER NOT NULL,
      depends_on TEXT NOT NULL  -- JSON string[]
    );

    CREATE TABLE IF NOT EXISTS resource_claims (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES transfer_nodes(id),
      claimed_by TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      expires_at TEXT,
      released INTEGER NOT NULL DEFAULT 0,
      released_at TEXT
    );

    -- ── Protocols ────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS protocol_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      version TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      status TEXT NOT NULL,
      tags TEXT NOT NULL,  -- JSON string[]
      required_capabilities TEXT NOT NULL,  -- JSON string[]
      parameters TEXT NOT NULL,  -- JSON
      default_values TEXT NOT NULL,  -- JSON
      estimated_total_duration_ms INTEGER NOT NULL,
      fork_count INTEGER NOT NULL DEFAULT 0,
      run_count INTEGER NOT NULL DEFAULT 0,
      rating REAL,
      forked_from TEXT,
      content_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS protocol_steps (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL REFERENCES protocol_templates(id),
      capability_type TEXT NOT NULL,
      label TEXT NOT NULL,
      action TEXT NOT NULL,
      params TEXT NOT NULL,  -- JSON
      parameter_bindings TEXT,  -- JSON
      estimated_duration_ms INTEGER NOT NULL,
      required_labware TEXT,
      produces_evidence INTEGER NOT NULL,
      depends_on TEXT NOT NULL,  -- JSON string[]
      position TEXT,  -- JSON { x, y }
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS protocol_transfers (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL REFERENCES protocol_templates(id),
      from_step_id TEXT NOT NULL REFERENCES protocol_steps(id),
      to_step_id TEXT NOT NULL REFERENCES protocol_steps(id),
      labware_type TEXT NOT NULL,
      constraints TEXT,  -- JSON
      preferred_automation_level TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS protocol_forks (
      id TEXT PRIMARY KEY,
      source_template_id TEXT NOT NULL REFERENCES protocol_templates(id),
      source_template_version TEXT NOT NULL,
      forked_by TEXT NOT NULL,
      parameter_overrides TEXT NOT NULL,  -- JSON
      step_overrides TEXT,  -- JSON
      name TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS protocol_runs (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL REFERENCES protocol_templates(id),
      template_version TEXT NOT NULL,
      fork_id TEXT REFERENCES protocol_forks(id),
      kernel_id TEXT NOT NULL ,
      job_id TEXT,
      parameter_values TEXT NOT NULL,  -- JSON
      status TEXT NOT NULL,
      current_step_index INTEGER NOT NULL DEFAULT 0,
      initiated_by TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      error TEXT,
      sample_ids TEXT NOT NULL,  -- JSON string[]
      metadata TEXT,  -- JSON
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS protocol_run_steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES protocol_runs(id),
      protocol_step_id TEXT NOT NULL REFERENCES protocol_steps(id),
      node_id TEXT NOT NULL,
      device_id TEXT,
      action TEXT NOT NULL,
      resolved_params TEXT NOT NULL,  -- JSON
      actual_duration_ms INTEGER,
      status TEXT NOT NULL,
      evidence_hash TEXT,
      claim_id TEXT,
      started_at TEXT,
      completed_at TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS protocol_run_transfers (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES protocol_runs(id),
      protocol_transfer_id TEXT NOT NULL REFERENCES protocol_transfers(id),
      from_node_id TEXT NOT NULL,
      to_node_id TEXT NOT NULL,
      transfer_agent_id TEXT,
      automation_level TEXT NOT NULL,
      mechanism TEXT NOT NULL,
      episode_recorded INTEGER NOT NULL DEFAULT 0,
      episode_id TEXT,
      status TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS automation_statuses (
      id TEXT PRIMARY KEY,
      kernel_id TEXT NOT NULL ,
      from_node_id TEXT NOT NULL,
      to_node_id TEXT NOT NULL,
      transfer_agent_id TEXT NOT NULL,
      current_level TEXT NOT NULL,
      episode_count INTEGER NOT NULL DEFAULT 0,
      min_episodes_for_training INTEGER NOT NULL,
      vla_model_id TEXT,
      vla_model_name TEXT,
      vla_success_rate REAL,
      advance_threshold REAL NOT NULL,
      last_episode_at TEXT,
      last_trained_at TEXT,
      metadata TEXT,  -- JSON
      UNIQUE(kernel_id, from_node_id, to_node_id)
    );

    CREATE TABLE IF NOT EXISTS transfer_agents (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      agent_ref TEXT NOT NULL,
      label TEXT NOT NULL,
      capabilities TEXT,  -- JSON string[]
      metadata TEXT  -- JSON
    );

    CREATE TABLE IF NOT EXISTS protocol_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES protocol_runs(id),
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      step_id TEXT,
      transfer_id TEXT,
      payload TEXT NOT NULL  -- JSON
    );

    -- ── Sensors ──────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sensor_channel_descriptors (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      kernel_id TEXT NOT NULL ,
      device_id TEXT NOT NULL REFERENCES kernel_devices(id),
      label TEXT NOT NULL,
      data_type TEXT NOT NULL,
      unit TEXT NOT NULL,
      sample_rate_hz REAL NOT NULL,
      range TEXT,  -- JSON { min, max }
      resolution REAL,
      retention_policy TEXT NOT NULL,
      evidence_grade INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sensor_aggregates (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      kernel_id TEXT NOT NULL ,
      device_id TEXT NOT NULL REFERENCES kernel_devices(id),
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      count INTEGER NOT NULL,
      min REAL NOT NULL,
      max REAL NOT NULL,
      mean REAL NOT NULL,
      stddev REAL,
      unit TEXT NOT NULL,
      job_id TEXT,
      batch_id TEXT
    );

    CREATE TABLE IF NOT EXISTS sensor_anomalies (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      kernel_id TEXT NOT NULL ,
      device_id TEXT NOT NULL REFERENCES kernel_devices(id),
      channel TEXT NOT NULL,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      value REAL NOT NULL,
      threshold REAL NOT NULL,
      message TEXT NOT NULL,
      job_id TEXT
    );

    -- ── Batches ──────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS batch_manifests (
      id TEXT PRIMARY KEY,
      kernel_id TEXT NOT NULL ,
      device_id TEXT NOT NULL REFERENCES kernel_devices(id),
      capability_id TEXT NOT NULL REFERENCES capabilities(id),
      status TEXT NOT NULL,
      sealed_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      run_config TEXT NOT NULL,  -- JSON
      method_id TEXT
    );

    CREATE TABLE IF NOT EXISTS sample_slots (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES batch_manifests(id),
      position TEXT NOT NULL,
      job_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      sample_label TEXT NOT NULL,
      sample_type TEXT,
      status TEXT NOT NULL,
      acquisition_start TEXT,
      acquisition_end TEXT,
      result_hash TEXT,
      result_ref TEXT
    );

    CREATE TABLE IF NOT EXISTS batch_events (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES batch_manifests(id),
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      slot_id TEXT,
      payload TEXT NOT NULL  -- JSON
    );

    -- ── Encryption ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS encrypted_evidence_bundles (
      id TEXT PRIMARY KEY,
      bundle_id TEXT NOT NULL REFERENCES evidence_bundles(id),
      bundle_hash TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      encrypted_at TEXT NOT NULL,
      ipfs_cid TEXT,
      ipfs_metadata_cid TEXT,
      filecoin_deal_id TEXT,
      lit_ciphertext TEXT,
      lit_data_to_encrypt_hash TEXT,
      lit_access_conditions TEXT,
      lit_network TEXT
    );

    CREATE TABLE IF NOT EXISTS key_capsules (
      id TEXT PRIMARY KEY,
      encrypted_bundle_id TEXT NOT NULL REFERENCES encrypted_evidence_bundles(id),
      recipient_address TEXT NOT NULL,
      encrypted_key TEXT NOT NULL,
      ephemeral_public_key TEXT NOT NULL,
      access_level TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS access_grants (
      id TEXT PRIMARY KEY,
      bundle_id TEXT NOT NULL REFERENCES evidence_bundles(id),
      granted_by TEXT NOT NULL,
      granted_to TEXT NOT NULL,
      capsule_id TEXT NOT NULL REFERENCES key_capsules(id),
      granted_at TEXT NOT NULL,
      expires_at TEXT,
      revoked INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS evidence_commitments (
      id TEXT PRIMARY KEY,
      bundle_hash TEXT NOT NULL,
      commitment_hash TEXT NOT NULL,
      merkle_root TEXT,
      merkle_index INTEGER,
      commitment_timestamp TEXT NOT NULL,
      on_chain_tx_hash TEXT
    );

    CREATE TABLE IF NOT EXISTS zk_proofs (
      id TEXT PRIMARY KEY,
      proof_type TEXT NOT NULL,
      commitment_id TEXT NOT NULL REFERENCES evidence_commitments(id),
      public_inputs TEXT NOT NULL,  -- JSON string[]
      proof TEXT NOT NULL,
      verification_key TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      generated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS commitment_trees (
      id TEXT PRIMARY KEY,
      root TEXT NOT NULL,
      depth INTEGER NOT NULL,
      leaf_count INTEGER NOT NULL,
      leaves TEXT NOT NULL,  -- JSON string[]
      created_at TEXT NOT NULL
    );

    -- ── Logistics ────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS logistics_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      service_types TEXT NOT NULL,  -- JSON string[]
      coverage_area TEXT NOT NULL,  -- JSON
      fleet_capabilities TEXT NOT NULL,  -- JSON
      contact TEXT NOT NULL,  -- JSON
      wallet_address TEXT,
      rating REAL NOT NULL DEFAULT 0,
      completed_jobs INTEGER NOT NULL DEFAULT 0,
      insurance_coverage TEXT NOT NULL,
      insurance_currency TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shipments (
      id TEXT PRIMARY KEY,
      machine_registration_id TEXT,
      equipment_description TEXT NOT NULL,
      provider_id TEXT NOT NULL REFERENCES logistics_providers(id),
      priority TEXT NOT NULL,
      status TEXT NOT NULL,
      origin TEXT NOT NULL,  -- JSON
      destination TEXT NOT NULL,  -- JSON
      current_location TEXT,  -- JSON
      package TEXT NOT NULL,  -- JSON
      quote TEXT,  -- JSON
      pickup_window TEXT NOT NULL,  -- JSON
      estimated_delivery TEXT,
      actual_pickup TEXT,
      actual_delivery TEXT,
      special_instructions TEXT,
      requires_lift_gate INTEGER NOT NULL,
      requires_inside_delivery INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shipment_tracking_events (
      id TEXT PRIMARY KEY,
      shipment_id TEXT NOT NULL REFERENCES shipments(id),
      timestamp TEXT NOT NULL,
      status TEXT NOT NULL,
      location TEXT,  -- JSON
      location_label TEXT,
      message TEXT NOT NULL,
      evidence_photos TEXT,  -- JSON string[]
      signed_by TEXT
    );

    CREATE TABLE IF NOT EXISTS condition_readings (
      id TEXT PRIMARY KEY,
      shipment_id TEXT NOT NULL REFERENCES shipments(id),
      timestamp TEXT NOT NULL,
      temperature REAL,
      humidity REAL,
      shock REAL,
      tilt REAL
    );

    CREATE TABLE IF NOT EXISTS space_bookings (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      space_name TEXT NOT NULL,
      slot_position TEXT,
      machine_registration_id TEXT,
      booking_contact TEXT NOT NULL,
      status TEXT NOT NULL,
      period TEXT NOT NULL,  -- JSON
      pricing_phase TEXT NOT NULL DEFAULT 'free',
      monthly_rate TEXT NOT NULL,
      price_per_sqft_month TEXT,
      sqft INTEGER,
      currency TEXT NOT NULL,
      deposit_amount TEXT,
      requirements TEXT NOT NULL,  -- JSON
      move_in_date TEXT,
      move_out_date TEXT,
      shipment_id TEXT,
      installation_order_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS installation_orders (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL REFERENCES space_bookings(id),
      space_id TEXT NOT NULL,
      machine_registration_id TEXT,
      equipment_description TEXT NOT NULL,
      status TEXT NOT NULL,
      assigned_to TEXT NOT NULL,  -- JSON
      scheduled_date TEXT NOT NULL,
      estimated_duration_hours REAL NOT NULL,
      actual_started_at TEXT,
      actual_completed_at TEXT,
      kernel_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS installation_steps (
      id TEXT PRIMARY KEY,
      installation_order_id TEXT NOT NULL REFERENCES installation_orders(id),
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      "order" INTEGER NOT NULL,
      estimated_minutes INTEGER NOT NULL,
      actual_minutes INTEGER,
      started_at TEXT,
      completed_at TEXT,
      completed_by TEXT,
      evidence_photos TEXT,  -- JSON string[]
      notes TEXT,
      requires_signoff INTEGER NOT NULL,
      signed_off_by TEXT
    );

    CREATE TABLE IF NOT EXISTS installation_notes (
      id TEXT PRIMARY KEY,
      installation_order_id TEXT NOT NULL REFERENCES installation_orders(id),
      timestamp TEXT NOT NULL,
      author TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS logistics_timeline_events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      related_ids TEXT NOT NULL  -- JSON
    );

    -- ── Onboarding ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS machine_registrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      manufacturer TEXT NOT NULL,
      model TEXT NOT NULL,
      serial_number TEXT,
      description TEXT,
      photos TEXT NOT NULL,  -- JSON string[]
      capabilities TEXT NOT NULL,  -- JSON
      space_requirements TEXT NOT NULL,  -- JSON
      pricing TEXT NOT NULL,  -- JSON
      operator TEXT NOT NULL,  -- JSON
      compliance_regulations TEXT,  -- T2.3: JSON string[] of regulationIds (optional)
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      submitted_at TEXT,
      approved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS onboarding_documents (
      id TEXT PRIMARY KEY,
      machine_registration_id TEXT NOT NULL REFERENCES machine_registrations(id),
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes TEXT NOT NULL,
      hash TEXT NOT NULL,
      uploaded_at TEXT NOT NULL,
      analysis_status TEXT NOT NULL,
      analysis_result TEXT  -- JSON
    );

    -- ── Marketplace ──────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS equipment_classes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      subcategory TEXT,
      description TEXT NOT NULL,
      common_materials TEXT NOT NULL,  -- JSON string[]
      typical_tolerances TEXT NOT NULL,  -- JSON string[]
      typical_price_range TEXT NOT NULL,  -- JSON
      space_requirements_range TEXT NOT NULL  -- JSON
    );

    CREATE TABLE IF NOT EXISTS hosting_spaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      operator_address TEXT NOT NULL,
      location TEXT NOT NULL,  -- JSON
      address TEXT NOT NULL,
      dimensions TEXT NOT NULL,  -- JSON
      power TEXT NOT NULL,  -- JSON
      amenities TEXT NOT NULL,  -- JSON string[]
      environmental_systems TEXT NOT NULL,  -- JSON string[]
      safety_features TEXT NOT NULL,  -- JSON string[]
      access TEXT NOT NULL,  -- JSON
      monthly_price TEXT NOT NULL,
      currency TEXT NOT NULL,
      available_slots INTEGER NOT NULL,
      total_slots INTEGER NOT NULL,
      rating REAL NOT NULL DEFAULT 0,
      current_machines TEXT  -- JSON string[]
    );

    CREATE TABLE IF NOT EXISTS maintenance_events (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL
    );

    -- ── Auth ─────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL,
      user_agent TEXT,
      ip_address TEXT
    );

    -- ── API Keys ──────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      operator_id TEXT NOT NULL,
      name TEXT,
      description TEXT,
      scopes TEXT NOT NULL,
      rate_limit TEXT NOT NULL DEFAULT '1000/hour',
      usage_count TEXT NOT NULL DEFAULT '0',
      last_used_at TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT,
      metadata TEXT
    );

    -- ── Story Protocol ────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS story_ip_registrations (
      ip_id TEXT PRIMARY KEY,
      nft_token_id TEXT NOT NULL,
      license_terms_id TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      capability_id TEXT,
      csd_url TEXT,
      chain TEXT NOT NULL DEFAULT 'story-aeneid',
      registered_at TEXT NOT NULL,
      FOREIGN KEY (capability_id) REFERENCES capabilities(id)
    );

    CREATE TABLE IF NOT EXISTS story_derivative_links (
      id TEXT PRIMARY KEY,
      parent_ip_id TEXT NOT NULL,
      child_ip_id TEXT NOT NULL,
      license_token_id TEXT NOT NULL,
      job_id TEXT,
      evidence_bundle_hash TEXT,
      tx_hash TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      FOREIGN KEY (parent_ip_id) REFERENCES story_ip_registrations(ip_id),
      FOREIGN KEY (job_id) REFERENCES jobs(id)
    );

    CREATE TABLE IF NOT EXISTS story_royalty_splits (
      id TEXT PRIMARY KEY,
      ip_id TEXT NOT NULL,
      address TEXT NOT NULL,
      role TEXT NOT NULL,
      percentage INTEGER NOT NULL,
      label TEXT NOT NULL,
      FOREIGN KEY (ip_id) REFERENCES story_ip_registrations(ip_id)
    );

    CREATE TABLE IF NOT EXISTS story_revenue_claims (
      id TEXT PRIMARY KEY,
      ip_id TEXT NOT NULL,
      claimer_address TEXT NOT NULL,
      amount TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      FOREIGN KEY (ip_id) REFERENCES story_ip_registrations(ip_id)
    );

    -- ── Sovereign Wealth Fund ─────────────────────────────────────

    CREATE TABLE IF NOT EXISTS swf_participants (
      id TEXT PRIMARY KEY,
      did TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      role TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS swf_epochs (
      id TEXT PRIMARY KEY,
      epoch_number INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      total_accrued TEXT NOT NULL DEFAULT '0',
      total_distributed TEXT NOT NULL DEFAULT '0',
      allocation_strategy TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      participant_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS swf_accruals (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      gross_amount TEXT NOT NULL,
      accrual_bps INTEGER NOT NULL,
      accrual_amount TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USDC',
      chain TEXT NOT NULL,
      accrued_at TEXT NOT NULL,
      epoch_id TEXT NOT NULL,
      FOREIGN KEY (epoch_id) REFERENCES swf_epochs(id)
    );

    CREATE TABLE IF NOT EXISTS swf_contribution_scores (
      id TEXT PRIMARY KEY,
      participant_id TEXT NOT NULL,
      epoch_id TEXT NOT NULL,
      job_volume REAL NOT NULL DEFAULT 0,
      reputation_score REAL NOT NULL DEFAULT 0,
      uptime_or_activity REAL NOT NULL DEFAULT 0,
      tenure_factor REAL NOT NULL DEFAULT 0,
      governance_participation REAL NOT NULL DEFAULT 0,
      total_score REAL NOT NULL DEFAULT 0,
      share_of_epoch REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (participant_id) REFERENCES swf_participants(id),
      FOREIGN KEY (epoch_id) REFERENCES swf_epochs(id)
    );

    CREATE TABLE IF NOT EXISTS swf_dividend_claims (
      id TEXT PRIMARY KEY,
      participant_id TEXT NOT NULL,
      epoch_id TEXT NOT NULL,
      amount TEXT NOT NULL,
      chain TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      tx_hash TEXT,
      claimed_at TEXT,
      FOREIGN KEY (participant_id) REFERENCES swf_participants(id),
      FOREIGN KEY (epoch_id) REFERENCES swf_epochs(id)
    );

    CREATE TABLE IF NOT EXISTS swf_proposals (
      id TEXT PRIMARY KEY,
      proposer TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      proposed_strategy TEXT NOT NULL,
      voting_start TEXT NOT NULL,
      voting_end TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      yes_votes REAL NOT NULL DEFAULT 0,
      no_votes REAL NOT NULL DEFAULT 0,
      total_voters INTEGER NOT NULL DEFAULT 0,
      quorum_required REAL NOT NULL DEFAULT 0.3,
      created_at TEXT NOT NULL,
      FOREIGN KEY (proposer) REFERENCES swf_participants(id)
    );

    CREATE TABLE IF NOT EXISTS swf_votes (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      vote TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 0,
      voted_at TEXT NOT NULL,
      FOREIGN KEY (proposal_id) REFERENCES swf_proposals(id),
      FOREIGN KEY (participant_id) REFERENCES swf_participants(id)
    );

    -- ── Operator Policies ──────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS operator_policies (
      kernel_id TEXT PRIMARY KEY ,
      policy TEXT NOT NULL,       -- JSON OperatorPolicy
      updated_at TEXT NOT NULL,
      updated_by TEXT             -- who last changed it
    );

    -- ── Pending Approvals ──────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS pending_approvals (
      id TEXT PRIMARY KEY,
      kernel_id TEXT NOT NULL ,
      job_id TEXT NOT NULL,
      session_id TEXT,            -- links to negotiation_sessions
      submitted_by TEXT NOT NULL,
      job_summary TEXT NOT NULL,  -- JSON
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      decided_at TEXT,
      rejection_reason TEXT,
      expires_at TEXT NOT NULL
    );

    -- ── Negotiation Sessions ───────────────────────────────────────
    CREATE TABLE IF NOT EXISTS negotiation_sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'created',
      user_agent_id TEXT NOT NULL,
      kernel_id TEXT NOT NULL,
      capability_type TEXT NOT NULL,
      capability_id TEXT,
      network TEXT,
      selections TEXT NOT NULL DEFAULT '{}',     -- JSON
      operator_constraints TEXT NOT NULL,         -- JSON snapshot
      scheduling TEXT,                            -- JSON
      quote TEXT,                                 -- JSON
      contract_terms TEXT,                        -- JSON
      job_id TEXT,
      escrow_address TEXT,
      cwm_id TEXT,
      transitions TEXT NOT NULL DEFAULT '[]',     -- JSON SessionTransition[]
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      committed_at TEXT
    );

    -- ── Policy Rate Counters ───────────────────────────────────────
    CREATE TABLE IF NOT EXISTS policy_rate_counters (
      kernel_id TEXT NOT NULL ,
      window_key TEXT NOT NULL,   -- "hour:2026-03-26T14" or "day:2026-03-26"
      count INTEGER NOT NULL DEFAULT 0,
      total_cost TEXT NOT NULL DEFAULT '0',
      PRIMARY KEY (kernel_id, window_key)
    );

    -- ── Shared Batches (multi-user runs) ───────────────────────────
    CREATE TABLE IF NOT EXISTS shared_batches (
      id TEXT PRIMARY KEY,
      kernel_id TEXT NOT NULL,
      capability_type TEXT NOT NULL,
      total_slots INTEGER NOT NULL,
      protocol_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      min_slots_to_run INTEGER NOT NULL DEFAULT 1,
      price_per_slot TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USDC',
      evidence_bundle_id TEXT,
      created_at TEXT NOT NULL,
      closes_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS batch_slot_claims (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES shared_batches(id),
      agent_id TEXT NOT NULL,
      slot_indices TEXT NOT NULL,  -- JSON number[]
      sample_labels TEXT NOT NULL, -- JSON string[]
      status TEXT NOT NULL DEFAULT 'claimed',
      amount TEXT NOT NULL,
      escrow_address TEXT,
      claimed_at TEXT NOT NULL
    );

    -- ── OT-2 Chat ────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS ot2_chat_messages (
      id TEXT PRIMARY KEY,
      kernel_id TEXT NOT NULL,
      role TEXT NOT NULL,            -- "user" | "assistant" | "system"
      content TEXT NOT NULL,
      tool_calls TEXT,               -- JSON array
      status TEXT NOT NULL DEFAULT 'pending',  -- "pending" | "processing" | "completed"
      created_at TEXT NOT NULL
    );

    -- ── OT-2 Camera ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS ot2_camera_frames (
      id TEXT PRIMARY KEY,
      kernel_id TEXT NOT NULL,
      frame_data TEXT NOT NULL,      -- base64 JPEG
      captured_at TEXT NOT NULL
    );

    -- ── Execution Scopes ────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS execution_scopes (
      id TEXT PRIMARY KEY,
      kernel_id TEXT NOT NULL,
      job_id TEXT,
      created_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      allowed_tools TEXT NOT NULL,          -- JSON string[]
      allowed_pipettes TEXT,               -- JSON string[]
      allowed_slots TEXT,                  -- JSON number[]
      max_commands INTEGER NOT NULL DEFAULT 100,
      command_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    -- ── Tool Call Relay ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS tool_call_relay (
      id TEXT PRIMARY KEY,
      scope_id TEXT,
      kernel_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_args TEXT NOT NULL,             -- JSON
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      claimed_at TEXT,
      completed_at TEXT
    );

    -- ── Audit Log ────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor TEXT,
      resource_type TEXT,
      resource_id TEXT,
      action TEXT NOT NULL,
      metadata TEXT,        -- JSON blob
      ip TEXT,
      user_agent TEXT
    );

    CREATE INDEX IF NOT EXISTS audit_log_event_type ON audit_log(event_type);
    CREATE INDEX IF NOT EXISTS audit_log_actor ON audit_log(actor);
    CREATE INDEX IF NOT EXISTS audit_log_resource_type ON audit_log(resource_type);
    CREATE INDEX IF NOT EXISTS audit_log_timestamp ON audit_log(timestamp);

    -- ── A2A Message Persistence ──────────────────────────────────────
    -- Append-only event log for all A2A messages that pass through the bus.
    -- Never updated after insert; prune only via pruneMessagesBefore().
    CREATE TABLE IF NOT EXISTS a2a_messages (
      id TEXT PRIMARY KEY,                      -- A2AMessage.id (nanoid)
      conversation_id TEXT NOT NULL,            -- A2AMessage.conversationId
      from_agent_id TEXT NOT NULL,              -- A2AMessage.from
      to_agent_id TEXT NOT NULL,                -- A2AMessage.to
      in_reply_to TEXT,                         -- A2AMessage.inReplyTo (nullable)
      intent_type TEXT NOT NULL,                -- A2AMessage.intent.type (indexed for filtering)
      intent_payload TEXT NOT NULL,             -- JSON of full A2AMessage.intent
      is_encrypted INTEGER NOT NULL DEFAULT 0,  -- 1 if A2AMessage.encrypted is set
      encrypted_envelope TEXT,                  -- JSON of A2AMessage.encrypted (nullable)
      signature TEXT,                           -- A2AMessage.signature (nullable)
      timestamp TEXT NOT NULL,                  -- A2AMessage.timestamp (ISO-8601)
      persisted_at TEXT NOT NULL                -- Wall-clock time of insert
    );

    CREATE INDEX IF NOT EXISTS a2a_messages_conversation ON a2a_messages(conversation_id);
    CREATE INDEX IF NOT EXISTS a2a_messages_to_agent ON a2a_messages(to_agent_id);
    CREATE INDEX IF NOT EXISTS a2a_messages_from_agent ON a2a_messages(from_agent_id);
    CREATE INDEX IF NOT EXISTS a2a_messages_timestamp ON a2a_messages(timestamp);
    CREATE INDEX IF NOT EXISTS a2a_messages_intent_type ON a2a_messages(intent_type);

    -- Conversation aggregate — upserted on every new message.
    -- Allows O(1) conversation lookup without scanning the message log.
    CREATE TABLE IF NOT EXISTS a2a_conversations (
      id TEXT PRIMARY KEY,                      -- Conversation.id
      participants TEXT NOT NULL,               -- JSON string[] of agent IDs
      status TEXT NOT NULL DEFAULT 'active',    -- "active" | "completed" | "failed" | "expired"
      topic TEXT NOT NULL,                      -- First message's intent.type
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS a2a_conversations_updated ON a2a_conversations(updated_at);
  `);

  // ══════════════════════════════════════════════════════════════════
  // ERP Patterns Foundation — 12 tables across 3 domains
  // (governance, templates, analytics) for Venkiteela-inspired patterns
  // ══════════════════════════════════════════════════════════════════
  sqlite.exec(`
    -- ── Governance ────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS rate_limit_policies (
      id TEXT PRIMARY KEY,
      route_pattern TEXT NOT NULL,
      cost_weight REAL NOT NULL DEFAULT 1,
      free_tier_limit INTEGER NOT NULL DEFAULT 100,
      paid_tier_limit INTEGER NOT NULL DEFAULT 10000,
      enterprise_tier_limit INTEGER NOT NULL DEFAULT 100000,
      window_ms INTEGER NOT NULL DEFAULT 3600000,
      burst_allowance INTEGER NOT NULL DEFAULT 10,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS dlp_rules (
      id TEXT PRIMARY KEY,
      field_path TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      visible_to_roles TEXT NOT NULL,
      redaction_strategy TEXT NOT NULL,
      mask_pattern TEXT,
      region_precision TEXT
    );

    CREATE TABLE IF NOT EXISTS endpoint_scopes (
      id TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      route_pattern TEXT NOT NULL,
      required_scopes TEXT NOT NULL,
      description TEXT
    );

    -- ── Templates ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS capability_template_store (
      id TEXT PRIMARY KEY,
      capability_type TEXT NOT NULL,
      version TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      template_data TEXT NOT NULL,
      author_id TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      tags TEXT,
      usage_count INTEGER NOT NULL DEFAULT 0,
      fork_count INTEGER NOT NULL DEFAULT 0,
      rating REAL,
      rating_count INTEGER NOT NULL DEFAULT 0,
      forked_from TEXT,
      is_verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS cap_tmpl_type ON capability_template_store(capability_type);
    CREATE INDEX IF NOT EXISTS cap_tmpl_status ON capability_template_store(status);

    CREATE TABLE IF NOT EXISTS machine_profile_store (
      id TEXT PRIMARY KEY,
      capability_type TEXT NOT NULL,
      machine_name TEXT NOT NULL,
      kernel_id TEXT,
      profile_data TEXT NOT NULL,
      author_id TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      tags TEXT,
      usage_count INTEGER NOT NULL DEFAULT 0,
      rating REAL,
      rating_count INTEGER NOT NULL DEFAULT 0,
      is_verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS machine_profile_type ON machine_profile_store(capability_type);
    CREATE INDEX IF NOT EXISTS machine_profile_kernel ON machine_profile_store(kernel_id);

    CREATE TABLE IF NOT EXISTS verification_templates (
      id TEXT PRIMARY KEY,
      capability_type TEXT NOT NULL,
      version TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      requirements TEXT NOT NULL,
      author_id TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      usage_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS ver_tmpl_type ON verification_templates(capability_type);

    CREATE TABLE IF NOT EXISTS query_templates (
      id TEXT PRIMARY KEY,
      intent TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      version TEXT NOT NULL,
      sql_template TEXT NOT NULL,
      data_sources TEXT NOT NULL,
      params TEXT NOT NULL,
      response_template TEXT NOT NULL,
      example_queries TEXT NOT NULL,
      author_id TEXT,
      usage_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS query_tmpl_intent ON query_templates(intent);

    CREATE TABLE IF NOT EXISTS template_ratings (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      template_type TEXT NOT NULL,
      rater_id TEXT NOT NULL,
      score INTEGER NOT NULL,
      comment TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tmpl_ratings_template ON template_ratings(template_id, template_type);

    -- ── Analytics ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS analytics_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      category TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      payload TEXT,
      hash TEXT NOT NULL,
      previous_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS analytics_events_type ON analytics_events(event_type);
    CREATE INDEX IF NOT EXISTS analytics_events_category ON analytics_events(category);
    CREATE INDEX IF NOT EXISTS analytics_events_actor ON analytics_events(actor_id);
    CREATE INDEX IF NOT EXISTS analytics_events_resource ON analytics_events(resource_type, resource_id);
    CREATE INDEX IF NOT EXISTS analytics_events_timestamp ON analytics_events(timestamp);

    CREATE TABLE IF NOT EXISTS materialized_views (
      id TEXT PRIMARY KEY,
      view_type TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      data TEXT NOT NULL,
      computed_at TEXT NOT NULL,
      event_count INTEGER NOT NULL DEFAULT 0,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mat_views_type_scope ON materialized_views(view_type, scope_key);

    CREATE TABLE IF NOT EXISTS compliance_templates (
      id TEXT PRIMARY KEY,
      regulation_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      version TEXT NOT NULL,
      industries TEXT NOT NULL,
      jurisdictions TEXT NOT NULL,
      applicable_capability_types TEXT NOT NULL,
      rules TEXT NOT NULL,
      minimum_assurance_tier INTEGER NOT NULL DEFAULT 0,
      retention_period_days INTEGER NOT NULL DEFAULT 365,
      author_id TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      superseded_by TEXT,
      effective_date TEXT NOT NULL,
      sunset_date TEXT,
      usage_count INTEGER NOT NULL DEFAULT 0,
      rating INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS comp_tmpl_regulation ON compliance_templates(regulation_id);
    CREATE INDEX IF NOT EXISTS comp_tmpl_status ON compliance_templates(status);

    CREATE TABLE IF NOT EXISTS compliance_profiles (
      id TEXT PRIMARY KEY,
      kernel_id TEXT NOT NULL,
      template_ids TEXT NOT NULL,
      industry TEXT NOT NULL,
      jurisdictions TEXT NOT NULL,
      overrides TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS comp_prof_kernel ON compliance_profiles(kernel_id);

    -- ── Capture Verification Protocol (Wave 4 — gateway-golf) ────────
    -- Mirrors packages/db/src/migrations/0001_capture_verdicts.sql and
    -- 0002_capture_anchors.sql. Kept inline here because the gateway's
    -- runtime migration is a single better-sqlite3 exec(), not drizzle-kit.
    CREATE TABLE IF NOT EXISTS capture_verdicts (
      id              TEXT PRIMARY KEY,
      job_id          TEXT,
      operator_id     TEXT NOT NULL,
      capture_hash    TEXT NOT NULL,
      manifest_hash   TEXT NOT NULL,
      declared_class  INTEGER NOT NULL,
      verified_class  INTEGER NOT NULL,
      verdict         TEXT NOT NULL CHECK (verdict IN ('PASS','PARTIAL','FAIL')),
      gates_passed    TEXT NOT NULL DEFAULT '[]',
      gates_failed    TEXT NOT NULL DEFAULT '[]',
      warnings        TEXT NOT NULL DEFAULT '[]',
      anchor_candidate INTEGER NOT NULL DEFAULT 0,
      result_json     TEXT NOT NULL DEFAULT '{}',
      declared_class_str TEXT NOT NULL,
      verified_class_str TEXT NOT NULL,
      created_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_capture_verdicts_job ON capture_verdicts(job_id);
    CREATE INDEX IF NOT EXISTS idx_capture_verdicts_hash ON capture_verdicts(capture_hash);
    CREATE INDEX IF NOT EXISTS idx_capture_verdicts_operator ON capture_verdicts(operator_id);

    CREATE TABLE IF NOT EXISTS capture_anchors (
      verdict_id   TEXT PRIMARY KEY REFERENCES capture_verdicts(id),
      tx_hash      TEXT NOT NULL UNIQUE,
      block_number INTEGER NOT NULL,
      gas_used     TEXT NOT NULL DEFAULT '0',
      anchored_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_capture_anchors_tx ON capture_anchors(tx_hash);

    -- ── Orchestrator Sessions (Wave 4.3 — persistent state for onboarder) ─
    -- Backs the @pcc/orchestrator-sdk SessionStore interface. Replaces the
    -- in-memory Map so onboarder sessions resume across gateway restarts.
    -- JSON columns round-trip via JSON.stringify/parse on the drizzle side.
    CREATE TABLE IF NOT EXISTS orchestrator_sessions (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      url           TEXT,
      contact_email TEXT,
      state         TEXT NOT NULL,
      capabilities  TEXT,        -- JSON array
      data_sources  TEXT,        -- JSON array
      backend       TEXT,        -- JSON object
      agent         TEXT,        -- JSON object
      extras        TEXT,        -- JSON object
      tenant_id     TEXT,        -- TODO(wave-4.1): scope queries by tenant
      updated_at    INTEGER NOT NULL  -- ms epoch
    );
    CREATE INDEX IF NOT EXISTS idx_orch_sessions_state ON orchestrator_sessions(state);
    CREATE INDEX IF NOT EXISTS idx_orch_sessions_tenant ON orchestrator_sessions(tenant_id);
  `);

  // ══════════════════════════════════════════════════════════════════
  // Contributor Economics — 4 tables for ContributorNFT profiles,
  // sealed RateSchedules, TrainingManifests, and CompositionManifests.
  // Wave 3c persistence; types live in @pcc/spec.
  // ══════════════════════════════════════════════════════════════════
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS contributor_profiles (
      id TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      role TEXT NOT NULL,
      schedule_hash TEXT NOT NULL,
      ip_id TEXT,
      contributor_nft_token_id TEXT,
      metadata_uri TEXT,
      registered_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS contributor_profiles_address
      ON contributor_profiles(address);
    CREATE INDEX IF NOT EXISTS contributor_profiles_role
      ON contributor_profiles(role);
    CREATE INDEX IF NOT EXISTS contributor_profiles_schedule_hash
      ON contributor_profiles(schedule_hash);

    CREATE TABLE IF NOT EXISTS rate_schedules (
      schedule_hash TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      segments_json TEXT NOT NULL,
      notes TEXT,
      published_by TEXT NOT NULL,
      published_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rate_schedules_published_by
      ON rate_schedules(published_by);
    CREATE INDEX IF NOT EXISTS rate_schedules_published_at
      ON rate_schedules(published_at);

    CREATE TABLE IF NOT EXISTS training_manifests (
      model_ip_id TEXT PRIMARY KEY,
      base_model_ip_id TEXT,
      dataset_weights_json TEXT NOT NULL,
      methodology_hash TEXT,
      manifest_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS training_manifests_base_model
      ON training_manifests(base_model_ip_id);

    CREATE TABLE IF NOT EXISTS composition_manifests (
      id TEXT PRIMARY KEY,
      capability_ip_id TEXT NOT NULL,
      escrow_address TEXT NOT NULL,
      milestone_index INTEGER NOT NULL,
      manifest_json TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      operator_residual_bps INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS composition_manifests_escrow_milestone
      ON composition_manifests(escrow_address, milestone_index);
    CREATE INDEX IF NOT EXISTS composition_manifests_capability
      ON composition_manifests(capability_ip_id);
  `);

  // ── Safe column additions for existing databases ──────────────────
  // SQLite ALTER TABLE ADD COLUMN is idempotent-safe when wrapped in try/catch.
  const safeAddColumn = (table: string, col: string, type: string) => {
    try { sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
  };
  safeAddColumn("jobs", "parameters", "TEXT");
  safeAddColumn("shop_kernels", "reputation_updated_at", "TEXT");
  // T2.3 — compliance_regulations on machine_registrations (additive for old DBs)
  safeAddColumn("machine_registrations", "compliance_regulations", "TEXT");
  // Wave 4.1.x — tenant_id on jobs (additive; same pattern as machine_registrations)
  safeAddColumn("jobs", "tenant_id", "TEXT");
  // Wave 4.1.x — tenant_id on evidence_bundles, capabilities, sensor_aggregates
  safeAddColumn("evidence_bundles", "tenant_id", "TEXT");
  safeAddColumn("capabilities", "tenant_id", "TEXT");
  // Human-node SLA (accept/deadline windows + presence + scheduling mode) on
  // capabilities — additive JSON-as-TEXT column; null for machine capabilities.
  safeAddColumn("capabilities", "sla", "TEXT");
  safeAddColumn("sensor_aggregates", "tenant_id", "TEXT");

  // ── feat/ed25519-keys-and-kernel-ttl (Skylar's audit) ──────────────────
  //
  // Capability + kernel registry hygiene. Every capability and kernel has a
  // soft expiry that the announcer extends via heartbeat. Listings drop
  // expired rows by default so the catalog stops returning ghost capabilities.
  //
  //   last_heartbeat_at — ISO timestamp of the most recent heartbeat.
  //   valid_until       — ISO timestamp after which the row stops appearing
  //                       in default listings (default = now + 24h on insert).
  //
  // Both columns are nullable for backward compat: rows that pre-date this
  // migration default to "always live" (null treated as not-expired) until
  // the next heartbeat or sweep sets the columns. See docs/kernel-lifecycle.md.
  safeAddColumn("capabilities", "last_heartbeat_at", "TEXT");
  safeAddColumn("capabilities", "valid_until", "TEXT");
  safeAddColumn("shop_kernels", "valid_until", "TEXT");

  // public_key on api_keys — the Ed25519 public key the agent uses to sign
  // evidence + heartbeats + handshakes. Set at provision time (server-
  // generated OR bring-your-own from the request body). Stored as raw
  // 32-byte hex. Nullable so pre-migration keys still resolve. The
  // verification route refuses when null.
  safeAddColumn("api_keys", "public_key", "TEXT");

  // Wave 4.1 — tenant_id on machine_registrations (interim multitenancy).
  // Application-layer filtering, gated by TENANT_ENFORCE env flag.
  safeAddColumn("machine_registrations", "tenant_id", "TEXT");

  // Wave 4.3 — orchestrator_sessions.tenant_id (forward-compat for DBs that
  // pre-date the column; CREATE TABLE above already includes it for fresh DBs)
  safeAddColumn("orchestrator_sessions", "tenant_id", "TEXT");

  // T2.7 — operator ratings.
  // Inline DDL here so the gateway's runtime migration covers it without
  // drizzle-kit. One rating row per (operator, job, buyer); the gateway
  // route enforces buyer-must-own-job upstream.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS operator_ratings (
      id TEXT PRIMARY KEY,
      operator_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      buyer_id TEXT NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_operator_ratings_operator ON operator_ratings(operator_id);
    CREATE INDEX IF NOT EXISTS idx_operator_ratings_job ON operator_ratings(job_id);
    CREATE INDEX IF NOT EXISTS idx_operator_ratings_buyer ON operator_ratings(buyer_id);
  `);

  // Wave 5 — demand-intent capture: capability requests previously lived in
  // an in-memory Map inside the gateway. Persist them and index the
  // compositionSignature so @pcc/demand-intel can fold many envelopes that
  // share the same composition shape efficiently.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS capability_requests (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      requester_email TEXT,
      requester_wallet TEXT,
      budget INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USDC',
      deadline TEXT NOT NULL,
      urgency TEXT NOT NULL,
      status TEXT NOT NULL,
      capability_dag TEXT NOT NULL,
      total_estimated_cost INTEGER NOT NULL DEFAULT 0,
      total_estimated_hours INTEGER NOT NULL DEFAULT 0,
      composition_signature TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS requests_composition_sig_idx ON capability_requests(composition_signature);
    CREATE INDEX IF NOT EXISTS requests_status_idx ON capability_requests(status);
    CREATE INDEX IF NOT EXISTS requests_urgency_idx ON capability_requests(urgency);
    CREATE INDEX IF NOT EXISTS requests_created_at_idx ON capability_requests(created_at);
  `);

  // Universal aggregator (Phase 1) — invocation receipts. One row per
  // proxied indexed-tool invocation, indexed by content-addressed CID for
  // fast lookup and by tool id / caller / dcc class for ranking + auditing.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS invocation_receipts (
      id TEXT PRIMARY KEY,
      receipt_cid TEXT NOT NULL,
      schema_version TEXT NOT NULL DEFAULT '1.0',
      indexed_tool_id TEXT NOT NULL,
      tool_cid TEXT NOT NULL,
      tool_schema_hash_at_call TEXT NOT NULL,
      requested_dcc_class TEXT NOT NULL,
      effective_dcc_class TEXT NOT NULL,
      downgrade_reason TEXT,
      pcc_signature TEXT NOT NULL,
      pcc_key_id TEXT NOT NULL,
      upstream_signature TEXT,
      upstream_key_id TEXT,
      sigstore_bundle_ref TEXT,
      tee_quote TEXT,
      zk_proof TEXT,
      caller_agent_id TEXT NOT NULL,
      caller_session_id TEXT NOT NULL,
      price_paid_usdc TEXT,
      payment_tx_hash TEXT,
      pcc_fee_bps INTEGER NOT NULL DEFAULT 0,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS invocation_receipts_cid_idx ON invocation_receipts(receipt_cid);
    CREATE INDEX IF NOT EXISTS invocation_receipts_tool_idx ON invocation_receipts(indexed_tool_id);
    CREATE INDEX IF NOT EXISTS invocation_receipts_caller_idx ON invocation_receipts(caller_agent_id);
    CREATE INDEX IF NOT EXISTS invocation_receipts_dcc_idx ON invocation_receipts(effective_dcc_class);
    CREATE INDEX IF NOT EXISTS invocation_receipts_created_idx ON invocation_receipts(created_at);
  `);

  // ══════════════════════════════════════════════════════════════════
  // Substrate persistence — the five agentic-substrate routes (compose,
  // asset-outbound, skills, reputation, graph-search) previously held all
  // state in process-local Maps, so every gateway redeploy wiped it. These
  // 14 tables back those routes so compositions, demands, budgets, skills,
  // reputation, and the capability graph survive restarts. Each row keeps the
  // exact domain object in a `data` JSON column for lossless round-trips;
  // flat objects (asset_budgets, agent_reputations) are column-only. Mirrors
  // packages/db/src/schema/substrate.ts and migrations/0003_substrate_persistence.sql.
  // Inline here because the gateway's runtime migration is one better-sqlite3
  // exec(), not drizzle-kit.
  sqlite.exec(`
    -- ── compose ──────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS compositions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      total_price_usd REAL NOT NULL DEFAULT 0,
      step_count INTEGER NOT NULL DEFAULT 0,
      requester_agent_id TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      data TEXT NOT NULL  -- JSON ComposeResponse
    );
    CREATE INDEX IF NOT EXISTS compositions_status_idx ON compositions(status);
    CREATE INDEX IF NOT EXISTS compositions_expires_idx ON compositions(expires_at);

    CREATE TABLE IF NOT EXISTS composition_candidates (
      capability_id TEXT PRIMARY KEY,
      kernel_id TEXT NOT NULL,
      operator_address TEXT NOT NULL,
      capability_type TEXT NOT NULL,
      estimated_price_usd REAL NOT NULL,
      estimated_duration_ms INTEGER NOT NULL,
      assurance_tier INTEGER NOT NULL,
      reputation INTEGER,
      available INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      data TEXT NOT NULL  -- JSON CompositionCandidate
    );
    CREATE INDEX IF NOT EXISTS composition_candidates_type_idx ON composition_candidates(capability_type);

    CREATE TABLE IF NOT EXISTS composition_executions (
      composition_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      data TEXT NOT NULL  -- JSON ExecuteCompositionResponse
    );

    -- ── reputation ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS agent_reputations (
      agent_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      score INTEGER NOT NULL,
      positive_contributions INTEGER NOT NULL DEFAULT 0,
      negative_contributions INTEGER NOT NULL DEFAULT 0,
      disputes_upheld INTEGER NOT NULL DEFAULT 0,
      disputes_rejected INTEGER NOT NULL DEFAULT 0,
      last_updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_reputations_kind_idx ON agent_reputations(kind);
    CREATE INDEX IF NOT EXISTS agent_reputations_score_idx ON agent_reputations(score);

    CREATE TABLE IF NOT EXISTS reputation_deltas (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      delta_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      delta REAL NOT NULL,
      reason TEXT NOT NULL,
      composition_id TEXT,
      step_index INTEGER,
      applied_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      data TEXT NOT NULL  -- JSON ReputationDelta
    );
    CREATE INDEX IF NOT EXISTS reputation_deltas_agent_idx ON reputation_deltas(agent_id);
    CREATE INDEX IF NOT EXISTS reputation_deltas_composition_idx ON reputation_deltas(composition_id);
    CREATE INDEX IF NOT EXISTS reputation_deltas_reason_idx ON reputation_deltas(reason);

    CREATE TABLE IF NOT EXISTS composition_step_outcomes (
      outcome_id TEXT PRIMARY KEY,
      composition_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      capability_id TEXT NOT NULL,
      status TEXT NOT NULL,
      final_reputation_applied INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      data TEXT NOT NULL  -- JSON CompositionStepOutcome
    );
    CREATE UNIQUE INDEX IF NOT EXISTS composition_step_outcomes_step_uq
      ON composition_step_outcomes(composition_id, step_index);

    CREATE TABLE IF NOT EXISTS composition_step_disputes (
      dispute_id TEXT PRIMARY KEY,
      composition_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      disputer_did TEXT NOT NULL,
      status TEXT NOT NULL,
      resolution TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL,
      data TEXT NOT NULL  -- JSON CompositionStepDispute
    );
    CREATE INDEX IF NOT EXISTS composition_step_disputes_composition_idx
      ON composition_step_disputes(composition_id);

    -- ── asset-outbound ───────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS asset_budgets (
      asset_id TEXT PRIMARY KEY,
      owner_did TEXT NOT NULL,
      budget_cap_usd REAL NOT NULL,
      daily_cap_usd REAL NOT NULL,
      spent_today_usd REAL NOT NULL DEFAULT 0,
      spent_lifetime_usd REAL NOT NULL DEFAULT 0,
      allowed_capability_types TEXT,  -- JSON string[] | NULL
      requires_owner_approval INTEGER,  -- 0/1 | NULL
      last_reset_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outbound_demands (
      demand_id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL,
      status TEXT NOT NULL,
      rejection_reason TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL  -- JSON OutboundDemandResponse
    );
    CREATE INDEX IF NOT EXISTS outbound_demands_asset_idx ON outbound_demands(asset_id);
    CREATE INDEX IF NOT EXISTS outbound_demands_status_idx ON outbound_demands(status);

    -- ── skills ───────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS skill_capabilities (
      id TEXT PRIMARY KEY,
      human_did TEXT NOT NULL,
      skill_type TEXT NOT NULL,
      hourly_rate_usd REAL NOT NULL,
      reputation INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL  -- JSON SkillCapability
    );
    CREATE INDEX IF NOT EXISTS skill_capabilities_type_idx ON skill_capabilities(skill_type);

    CREATE TABLE IF NOT EXISTS skill_jobs (
      job_id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL  -- JSON SkillJob
    );
    CREATE INDEX IF NOT EXISTS skill_jobs_skill_idx ON skill_jobs(skill_id);

    -- ── graph-search ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS graph_search_nodes (
      capability_id TEXT PRIMARY KEY,
      capability_type TEXT NOT NULL,
      kernel_id TEXT NOT NULL,
      estimated_price_usd REAL NOT NULL,
      estimated_duration_ms INTEGER NOT NULL,
      assurance_tier INTEGER NOT NULL,
      reputation INTEGER NOT NULL DEFAULT 0,
      available INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      data TEXT NOT NULL  -- JSON CapabilityGraphNode
    );
    CREATE INDEX IF NOT EXISTS graph_search_nodes_type_idx ON graph_search_nodes(capability_type);

    CREATE TABLE IF NOT EXISTS graph_search_edges (
      id TEXT PRIMARY KEY,  -- edge key: fromCapabilityId + '->' + toCapabilityId
      from_capability_id TEXT NOT NULL,
      to_capability_id TEXT NOT NULL,
      capability_type_flow TEXT NOT NULL,
      created_at TEXT NOT NULL,
      data TEXT NOT NULL  -- JSON CapabilityGraphEdge
    );
    CREATE INDEX IF NOT EXISTS graph_search_edges_from_idx ON graph_search_edges(from_capability_id);

    CREATE TABLE IF NOT EXISTS graph_search_proposals (
      id TEXT PRIMARY KEY,
      request_json TEXT NOT NULL,
      options_json TEXT NOT NULL,
      search_stats_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // ══════════════════════════════════════════════════════════════════
  // CSD usage attribution — backs the SQLite CsdUsageRepository.
  // Replaces the in-memory Map introduced in PR #118 so per-CSD adoption
  // counters survive gateway restart. Opt-in via PCC_CSD_PERSIST=true; the
  // default in-memory backend keeps suggest-templates tests fast.
  // ══════════════════════════════════════════════════════════════════
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS csd_usage (
      url               TEXT PRIMARY KEY,
      count             INTEGER NOT NULL DEFAULT 0,
      recent_adopters   TEXT NOT NULL DEFAULT '[]',  -- JSON string[]
      last_used_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS csd_usage_count_idx ON csd_usage(count DESC);
  `);
}
