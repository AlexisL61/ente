import "package:flutter/material.dart";
import "package:photos/models/api/collection/user.dart";
import "package:photos/models/file/file.dart";
import "package:photos/models/search/hierarchical/hierarchical_search_filter.dart";

class ContactsFilter extends HierarchicalSearchFilter {
  final User user;
  final int occurrence;

  ContactsFilter({
    required this.user,
    required this.occurrence,
    super.filterTypeName = "contactsFilter",
    super.matchedUploadedIDs,
  });

  @override
  String name() {
    if (user.name == null || user.name!.isEmpty) {
      return user.email.split("@")[0];
    }
    return user.name!;
  }

  @override
  int relevance() {
    return occurrence;
  }

  @override
  bool isMatch(EnteFile file) {
    return file.ownerID == user.id;
  }

  @override
  bool isSameFilter(HierarchicalSearchFilter other) {
    if (other is ContactsFilter) {
      return other.user.id == user.id;
    }
    return false;
  }

  @override
  IconData? icon() {
    return Icons.person_outlined;
  }
}