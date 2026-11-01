//! Git identities ("profiles"): who commits, which SSH key is offered, and which
//! host tokens are available. Profile metadata is a small JSON file in the app data
//! directory; tokens live only in the OS keychain (see `perseus-credentials`).

mod overrides;
mod store;

pub use overrides::helper_path;
pub use store::{Profile, ProfileInput, ProfileStore, ProfilesSnapshot};
