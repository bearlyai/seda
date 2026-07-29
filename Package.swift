// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "Seda",
    platforms: [
        .macOS(.v13),
        .iOS(.v16),
    ],
    products: [
        .library(name: "Seda", targets: ["Seda"]),
    ],
    targets: [
        .target(
            name: "Seda",
            path: "sdks/swift/Sources/Seda"
        ),
        .testTarget(
            name: "SedaTests",
            dependencies: ["Seda"],
            path: "sdks/swift/Tests/SedaTests"
        ),
    ]
)
