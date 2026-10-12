// Generated from Engine native ABI. Do not edit.
export const operations = {
  "context_create": [
    "pointer",
    "pointer"
  ],
  "context_close": [
    "pointer",
    "pointer"
  ],
  "context_release": [
    "pointer"
  ],
  "clock_now": [
    "pointer"
  ],
  "spatial_create": [
    "pointer",
    "pointer"
  ],
  "spatial_destroy": [
    "pointer",
    "pointer"
  ],
  "spatial_upsert": [
    "pointer",
    "pointer",
    "u64",
    "pointer"
  ],
  "spatial_remove": [
    "pointer",
    "pointer",
    "u64"
  ],
  "spatial_query_aabb_batch": [
    "pointer",
    "pointer",
    "pointer",
    "u32",
    "pointer",
    "u32",
    "pointer"
  ],
  "hfsm_compile": [
    "pointer",
    "pointer",
    "pointer"
  ],
  "hfsm_destroy_definition": [
    "pointer",
    "pointer"
  ],
  "hfsm_definition_info": [
    "pointer",
    "pointer",
    "pointer"
  ],
  "hfsm_evaluate": [
    "pointer",
    "pointer",
    "pointer",
    "pointer"
  ],
  "codec_base64_encode": [
    "pointer",
    "u32",
    "pointer",
    "u32",
    "pointer"
  ],
  "block_read_cell": [
    "handle",
    "pointer",
    "pointer"
  ],
  "block_read_box": [
    "handle",
    "pointer",
    "pointer",
    "u32",
    "pointer",
    "pointer",
    "u32",
    "pointer",
    "pointer"
  ],
  "block_read_column": [
    "handle",
    "pointer",
    "pointer",
    "u32",
    "pointer",
    "pointer",
    "u32",
    "pointer",
    "pointer"
  ],
  "section_revision_query": [
    "handle",
    "pointer",
    "pointer"
  ],
  "residency_pin_declare": [
    "handle",
    "pointer",
    "u32",
    "u32",
    "pointer"
  ],
  "residency_pin_release": [
    "handle",
    "pointer"
  ],
  "residency_pin_status": [
    "handle",
    "pointer",
    "pointer"
  ],
  "raycast": [
    "handle",
    "pointer",
    "pointer"
  ],
  "sweep": [
    "handle",
    "pointer",
    "pointer"
  ],
  "overlap": [
    "handle",
    "pointer",
    "pointer",
    "u32",
    "pointer"
  ],
  "voxel_capture": [
    "handle",
    "pointer",
    "u32",
    "pointer"
  ],
  "voxel_restore": [
    "handle",
    "pointer",
    "u32"
  ],
  "voxel_world_create": [
    "handle",
    "pointer",
    "pointer",
    "pointer",
    "u32",
    "pointer"
  ],
  "voxel_world_destroy": [
    "handle"
  ],
  "binding_set": [
    "handle",
    "pointer",
    "pointer",
    "pointer"
  ],
  "binding_clear": [
    "handle",
    "pointer",
    "pointer"
  ],
  "binding_get": [
    "handle",
    "pointer",
    "pointer",
    "u32",
    "pointer"
  ],
  "voxel_mutation_prepare": [
    "handle",
    "pointer",
    "pointer"
  ],
  "section_delivery": [
    "handle",
    "pointer",
    "pointer",
    "u32",
    "pointer"
  ],
  "voxel_mutation_commit": [
    "handle",
    "pointer",
    "pointer",
    "pointer",
    "u32",
    "pointer",
    "pointer",
    "u32",
    "pointer"
  ],
  "voxel_mutation_abort": [
    "handle",
    "pointer"
  ],
  "voxel_receipt_query": [
    "handle",
    "u64",
    "pointer",
    "pointer",
    "u32",
    "pointer",
    "pointer",
    "u32",
    "pointer"
  ],
  "voxel_mutation_output_requirements": [
    "handle",
    "pointer",
    "pointer",
    "pointer"
  ],
  "voxel_binding_context_replace": [
    "handle",
    "pointer",
    "u32"
  ],
  "voxel_prediction_session_open": [
    "handle",
    "pointer",
    "pointer"
  ],
  "voxel_prediction_session_close": [
    "handle",
    "pointer"
  ],
  "voxel_prediction_session_stats": [
    "handle",
    "pointer",
    "pointer"
  ],
  "voxel_prediction_begin_update": [
    "handle",
    "pointer",
    "pointer"
  ],
  "voxel_prediction_stage": [
    "handle",
    "pointer",
    "u64",
    "pointer",
    "pointer"
  ],
  "voxel_prediction_undo": [
    "handle",
    "pointer",
    "u64",
    "u64",
    "pointer"
  ],
  "voxel_prediction_complete_update": [
    "handle",
    "pointer",
    "u64",
    "pointer"
  ],
  "voxel_prediction_read_cell": [
    "handle",
    "pointer",
    "pointer",
    "pointer"
  ],
  "voxel_prediction_binding_get": [
    "handle",
    "pointer",
    "pointer",
    "u32",
    "pointer",
    "u32",
    "pointer",
    "pointer"
  ],
  "voxel_prediction_raycast": [
    "handle",
    "pointer",
    "pointer",
    "pointer",
    "pointer"
  ],
  "voxel_prediction_sweep": [
    "handle",
    "pointer",
    "pointer",
    "pointer",
    "pointer"
  ],
  "voxel_prediction_overlap": [
    "handle",
    "pointer",
    "pointer",
    "pointer",
    "u32",
    "pointer",
    "pointer"
  ],
  "voxel_prediction_release_covered": [
    "handle",
    "pointer",
    "u64",
    "u64",
    "u64",
    "pointer"
  ],
  "voxel_prediction_correction_reset": [
    "handle",
    "pointer",
    "u64",
    "pointer",
    "u32",
    "pointer",
    "u32",
    "pointer"
  ],
  "voxel_prediction_working_read_cell": [
    "handle",
    "pointer",
    "u64",
    "pointer",
    "u32",
    "pointer",
    "pointer",
    "pointer",
    "u32",
    "pointer"
  ],
  "voxel_prediction_working_binding_get": [
    "handle",
    "pointer",
    "u64",
    "pointer",
    "u32",
    "pointer",
    "u32",
    "pointer",
    "u32",
    "pointer",
    "pointer",
    "pointer",
    "u32",
    "pointer"
  ],
  "voxel_prediction_working_raycast": [
    "handle",
    "pointer",
    "u64",
    "pointer",
    "u32",
    "pointer",
    "pointer",
    "pointer",
    "u32",
    "pointer"
  ],
  "voxel_prediction_working_sweep": [
    "handle",
    "pointer",
    "u64",
    "pointer",
    "u32",
    "pointer",
    "pointer",
    "pointer",
    "u32",
    "pointer"
  ],
  "voxel_prediction_working_overlap": [
    "handle",
    "pointer",
    "u64",
    "pointer",
    "u32",
    "pointer",
    "pointer",
    "u32",
    "pointer",
    "pointer",
    "u32",
    "pointer"
  ],
  "voxel_section_request": [
    "handle",
    "pointer"
  ],
  "voxel_section_export_open": [
    "handle",
    "pointer",
    "pointer"
  ],
  "voxel_section_export_close": [
    "handle",
    "pointer"
  ],
  "voxel_section_snapshot_acquire": [
    "handle",
    "pointer",
    "pointer",
    "pointer"
  ],
  "voxel_section_snapshot_release": [
    "handle",
    "pointer"
  ],
  "voxel_section_export_read": [
    "handle",
    "pointer",
    "pointer",
    "pointer",
    "u32",
    "pointer"
  ],
  "voxel_change_observation_configure": [
    "handle",
    "pointer",
    "pointer"
  ],
  "voxel_change_observation_drain": [
    "handle",
    "pointer",
    "u32",
    "pointer"
  ],
  "voxel_section_binding_read": [
    "handle",
    "pointer",
    "pointer",
    "u32",
    "pointer"
  ],
  "voxel_section_durability_ack": [
    "handle",
    "pointer",
    "pointer"
  ],
  "voxel_section_unload": [
    "handle",
    "pointer",
    "pointer"
  ],
  "voxel_section_release": [
    "handle",
    "pointer",
    "pointer"
  ],
  "voxel_section_load": [
    "handle",
    "pointer",
    "pointer",
    "u32",
    "pointer"
  ]
};
