import type Database from "better-sqlite3";

/**
 * Creates all tables using raw SQL via better-sqlite3.
 * This avoids needing drizzle-kit at runtime.
 */
export function migrateDatabase(sqlite: Database.Database): void {
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
      kernel_id TEXT NOT NULL REFERENCES shop_kernels(id),
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
      kernel_id TEXT NOT NULL REFERENCES shop_kernels(id),
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
      kernel_id TEXT NOT NULL REFERENCES shop_kernels(id),
      status TEXT NOT NULL,
      assigned_devices TEXT NOT NULL,  -- JSON string[]
      started_at TEXT,
      completed_at TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      evidence_bundle_id TEXT
    );

    -- ── Evidence ─────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS evidence_bundles (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      step_id TEXT NOT NULL,
      kernel_id TEXT NOT NULL REFERENCES shop_kernels(id),
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
      kernel_id TEXT NOT NULL REFERENCES shop_kernels(id),
      created_at TEXT NOT NULL,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS transfer_nodes (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL REFERENCES transfer_graphs(id),
      kernel_id TEXT NOT NULL REFERENCES shop_kernels(id),
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
      kernel_id TEXT NOT NULL REFERENCES shop_kernels(id),
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
      kernel_id TEXT NOT NULL REFERENCES shop_kernels(id),
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
      kernel_id TEXT NOT NULL REFERENCES shop_kernels(id),
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
      kernel_id TEXT NOT NULL REFERENCES shop_kernels(id),
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
      kernel_id TEXT NOT NULL REFERENCES shop_kernels(id),
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
      kernel_id TEXT NOT NULL REFERENCES shop_kernels(id),
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
      kernel_id TEXT NOT NULL REFERENCES shop_kernels(id),
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
      kernel_id TEXT PRIMARY KEY REFERENCES shop_kernels(id),
      policy TEXT NOT NULL,       -- JSON OperatorPolicy
      updated_at TEXT NOT NULL,
      updated_by TEXT             -- who last changed it
    );

    -- ── Pending Approvals ──────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS pending_approvals (
      id TEXT PRIMARY KEY,
      kernel_id TEXT NOT NULL REFERENCES shop_kernels(id),
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
      kernel_id TEXT NOT NULL REFERENCES shop_kernels(id),
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
      kernel_id TEXT NOT NULL REFERENCES shop_kernels(id),
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
  `);
}
