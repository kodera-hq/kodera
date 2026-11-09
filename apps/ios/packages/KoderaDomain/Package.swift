// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "KoderaDomain",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "KoderaDomain", targets: ["KoderaDomain"])],
    targets: [
        .target(name: "KoderaDomain"),
        .testTarget(name: "KoderaDomainTests", dependencies: ["KoderaDomain"])
    ]
)
