// Evidence Inclusion Circuit
//
// Proves that a given evidence bundle hash is included in a Merkle commitment tree
// without revealing the full tree contents. Used for on-chain dispute resolution.
//
// Uses Pedersen hash (native to Barretenberg, ZK-friendly).
//
// Public inputs:
//   - merkle_root: the published Merkle root (Field element)
//   - leaf_hash: the evidence bundle's commitment hash (Field element)
//
// Private witnesses:
//   - sibling_path: Merkle sibling hashes (up to 8 levels = 256 leaves max)
//   - path_indices: direction bits (0 = left, 1 = right) for each level
//   - tree_depth: actual depth of the tree (1..8)

// Maximum tree depth (supports up to 256 leaves)
global MAX_DEPTH: u32 = 8;

fn main(
    // Public inputs
    merkle_root: pub Field,
    leaf_hash: pub Field,
    // Private witnesses
    sibling_path: [Field; MAX_DEPTH],
    path_indices: [Field; MAX_DEPTH],
    tree_depth: u32,
) {
    // Validate tree depth
    assert(tree_depth >= 1);
    assert(tree_depth <= MAX_DEPTH);

    // Walk up the tree, hashing with siblings
    let mut current = leaf_hash;

    for i in 0..MAX_DEPTH {
        if i < tree_depth {
            // Validate path_indices are binary
            let idx = path_indices[i];
            assert((idx == 0) | (idx == 1));

            // Hash current with sibling, order determined by path index
            if idx == 0 {
                // current is left child
                current = std::hash::pedersen_hash([current, sibling_path[i]]);
            } else {
                // current is right child
                current = std::hash::pedersen_hash([sibling_path[i], current]);
            }
        }
        // For levels beyond tree_depth, current stays unchanged
    }

    // Final hash must equal the published Merkle root
    assert(current == merkle_root);
}

#[test]
fn test_depth_1() {
    // 2 leaves: hash(leaf, sibling) = root
    let leaf: Field = 42;
    let sibling: Field = 99;
    let root = std::hash::pedersen_hash([leaf, sibling]);

    let mut path: [Field; MAX_DEPTH] = [0; MAX_DEPTH];
    path[0] = sibling;
    let mut indices: [Field; MAX_DEPTH] = [0; MAX_DEPTH];

    main(root, leaf, path, indices, 1);
}

#[test]
fn test_depth_2() {
    // 4 leaves: build a 2-level tree
    let l0: Field = 10;
    let l1: Field = 20;
    let l2: Field = 30;
    let l3: Field = 40;

    let n0 = std::hash::pedersen_hash([l0, l1]);
    let n1 = std::hash::pedersen_hash([l2, l3]);
    let root = std::hash::pedersen_hash([n0, n1]);

    // Prove l0 is in the tree: path = [l1, n1], indices = [0, 0]
    let mut path: [Field; MAX_DEPTH] = [0; MAX_DEPTH];
    path[0] = l1;
    path[1] = n1;
    let mut indices: [Field; MAX_DEPTH] = [0; MAX_DEPTH];

    main(root, l0, path, indices, 2);
}

#[test]
fn test_right_child() {
    // Prove l1 in a 2-leaf tree: path = [l0], indices = [1]
    let l0: Field = 10;
    let l1: Field = 20;
    let root = std::hash::pedersen_hash([l0, l1]);

    let mut path: [Field; MAX_DEPTH] = [0; MAX_DEPTH];
    path[0] = l0;
    let mut indices: [Field; MAX_DEPTH] = [0; MAX_DEPTH];
    indices[0] = 1;

    main(root, l1, path, indices, 1);
}
