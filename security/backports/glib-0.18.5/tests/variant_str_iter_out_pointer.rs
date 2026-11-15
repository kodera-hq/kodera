//! Proposed integration test for the exact backported GLib package; run optimized after approval.
use glib::{prelude::*, Variant};
use std::hint::black_box;

#[test]
fn variant_str_iter_out_pointer_optimized_regression() {
    for round in 0..64 {
        for length in [0, 1, 2, 8, 32] {
            let values: Vec<String> = (0..length)
                .map(|index| {
                    if index == 0 {
                        String::new()
                    } else {
                        format!("fixture-{round}-{index}-\u{03bb}-\u{1f30d}")
                    }
                })
                .collect();
            let variant =
                Variant::array_from_iter::<String>(values.iter().map(|value| value.to_variant()));
            let expected: Vec<&str> = values.iter().map(String::as_str).collect();
            let view = black_box(&variant);
            // Comparing actual values forces the FFI out-pointer/CStr path; count/len alone do not.
            let forward: Vec<_> = view.array_iter_str().unwrap().collect();
            assert_eq!(black_box(forward), expected);
            let backward: Vec<_> = view.array_iter_str().unwrap().rev().collect();
            assert_eq!(backward, expected.iter().copied().rev().collect::<Vec<_>>());
            assert_eq!(
                view.array_iter_str().unwrap().last(),
                expected.last().copied()
            );
            let mut exhausted = view.array_iter_str().unwrap();
            for value in &expected {
                assert_eq!(exhausted.next(), Some(*value));
            }
            assert_eq!(exhausted.next(), None);
            assert_eq!(exhausted.next_back(), None);
            if length >= 8 {
                let mut mixed = view.array_iter_str().unwrap();
                assert_eq!(mixed.next(), Some(expected[0]));
                assert_eq!(mixed.next_back(), Some(expected[length - 1]));
                assert_eq!(mixed.nth(2), Some(expected[3]));
                assert_eq!(mixed.nth_back(1), Some(expected[length - 3]));
                assert_eq!(mixed.len(), length - 7);
                assert_eq!(mixed.collect::<Vec<_>>(), expected[4..length - 3]);
            }
        }
    }
}
