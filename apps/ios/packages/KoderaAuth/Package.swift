// swift-tools-version: 6.0
import PackageDescription

// Apple platforms only: AppAuth needs UIKit or AppKit, so the Linux job does not build this package.
let package = Package(
    name: "KoderaAuth",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "KoderaAuth", targets: ["KoderaAuth"])],
    dependencies: [
        .package(url: "https://github.com/openid/AppAuth-iOS.git", exact: "3.0.0"),
        .package(path: "../KoderaDomain"),
        .package(path: "../KoderaClient"),
    ],
    targets: [
        .target(name: "KoderaAuth", dependencies: [
            .product(name: "AppAuth", package: "AppAuth-iOS"),
            "KoderaDomain",
            "KoderaClient",
        ]),
        .testTarget(name: "KoderaAuthTests", dependencies: ["KoderaAuth"]),
    ]
)
